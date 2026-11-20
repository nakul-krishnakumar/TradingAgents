"""Keep a Quick Tunnel connected across authenticated Market Desk restarts."""

from __future__ import annotations

import argparse
import http.client
import json
import logging
import os
import platform
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from time import monotonic, sleep
from urllib.request import urlopen

from dotenv import dotenv_values, set_key

from tradingagents.dataflows.files import locked, replace_file
from tradingagents.diagnostics import Redactor, configure_logging, event, exception_fields

_DOWNLOADS = "https://github.com/cloudflare/cloudflared/releases/latest/download"
_PASSWORD_NAME = "TRADINGAGENTS_TUNNEL_PASSWORD"
_QUICK_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com(?![a-z0-9.-])")
logger = logging.getLogger(__name__)


def cloudflared_path():
    installed = shutil.which("cloudflared")
    if installed:
        return installed

    target = Path(sys.executable).with_name("cloudflared")
    if os.access(target, os.X_OK):
        return str(target)
    system = platform.system().lower()
    arch = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64", "amd64": "amd64"}.get(platform.machine().lower())
    if system not in {"linux", "darwin"} or not arch:
        raise ValueError("Install cloudflared on your PATH for this platform.")
    asset = f"cloudflared-{system}-{arch}" + (".tgz" if system == "darwin" else "")
    print("Downloading cloudflared from Cloudflare's official release…", flush=True)
    event(logger, "tunnel.download_started", "Downloading Cloudflare tunnel executable", system=system, architecture=arch)
    with TemporaryDirectory(dir=target.parent) as folder:
        downloaded = Path(folder) / asset
        with urlopen(f"{_DOWNLOADS}/{asset}", timeout=45) as response, downloaded.open("wb") as output:
            shutil.copyfileobj(response, output)
        executable = downloaded
        if system == "darwin":
            executable = Path(folder) / "cloudflared"
            with tarfile.open(downloaded, "r:gz") as archive:
                member = next((file for file in archive if file.isfile() and Path(file.name).name == "cloudflared"), None)
                if member is None:
                    raise ValueError("The cloudflared release did not include the expected executable.")
                with archive.extractfile(member) as binary, executable.open("wb") as output:
                    shutil.copyfileobj(binary, output)
        executable.chmod(0o755)
        executable.replace(target)
    return str(target)


def tunnel_password():
    path = Path(".env")
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    value = dotenv_values(path, interpolate=False).get(_PASSWORD_NAME)
    if value:
        if len(value) < 16:
            raise ValueError(f"Set {_PASSWORD_NAME} in .env to a password with at least 16 characters.")
        return value
    value = secrets.token_urlsafe(24)
    saved, _, _ = set_key(path, _PASSWORD_NAME, value)
    if not saved:
        raise ValueError("The tunnel password could not be saved to .env.")
    path.chmod(0o600)
    print(f"Created {_PASSWORD_NAME} in .env.", flush=True)
    return value


def _state_dir(port):
    return Path(".venv") / "market-desk-tunnels" / str(port)


def _origin_path(port):
    return _state_dir(port) / "origin.sock"


def serve_origin(app, port):
    """Serve both the local port and the tunnel's private Unix socket."""
    import uvicorn

    directory = _state_dir(port)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = _origin_path(port)
    with locked(directory / "origin", wait=False) as acquired:
        if not acquired:
            raise RuntimeError(f"A Market Desk instance already owns the tunnel origin for port {port}.")
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as local, \
                socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as origin:
            local.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            local.bind(("127.0.0.1", port))
            path.unlink(missing_ok=True)
            origin.bind(str(path))
            try:
                path.chmod(0o600)
                config = uvicorn.Config(app, access_log=False, log_config=None)
                uvicorn.Server(config).run(sockets=[local, origin])
            finally:
                path.unlink(missing_ok=True)


class _OriginConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=1)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(str(self.path))


def wait_for_auth(server, port):
    deadline = monotonic() + 25
    while monotonic() < deadline and server.poll() is None:
        connection = _OriginConnection(_origin_path(port))
        try:
            connection.request("GET", "/api/settings")
            response = connection.getresponse()
            if response.status == 401 and response.getheader("WWW-Authenticate", "").startswith('Basic realm="Market Desk"'):
                return
            raise ValueError("Market Desk's tunnel origin did not require authentication.")
        except OSError:
            sleep(0.25)
        finally:
            connection.close()
    raise ValueError("Market Desk did not become ready. Check the server output above.")


def terminate(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def start_dashboard(port, *, env):
    process = subprocess.Popen(
        [sys.executable, "-m", "tradingagents.dashboard.api", str(port)],
        env=env,
    )
    event(logger, "launcher.dashboard_started", "Market Desk process started", pid=process.pid, port=port)
    return process


def _record_tunnel_output(stream, url_file):
    redact = Redactor()
    with stream:
        for line in stream:
            if not url_file.exists() and (match := _QUICK_URL.search(line)):
                replace_file(url_file, lambda file: Path(file).write_text(match[0] + "\n"), strict=True)
            safe = redact.text(line.strip())
            if safe:
                event(logger, "tunnel.output", "Cloudflare tunnel diagnostic", detail=safe)
                print(safe, flush=True)


def connector_active(port):
    directory = _state_dir(port)
    if not directory.is_dir():
        return False
    with locked(directory / "connector", wait=False) as acquired:
        return not acquired


def _stop(*_):
    raise KeyboardInterrupt


def _run_connector(port):
    directory = _state_dir(port)
    url_file, stop_file = directory / "url", directory / "stop"
    with locked(directory / "connector", wait=False) as acquired:
        if not acquired:
            return 0
        signal.signal(signal.SIGTERM, _stop)
        connector = reader = None
        try:
            with TemporaryDirectory() as folder:
                settings = Path(folder) / "cloudflared.yml"
                settings.write_text(json.dumps({
                    "ingress": [{"service": f"unix:{_origin_path(port)}"}],
                }), encoding="utf-8")
                # --url triggers Quick Tunnel provisioning. Ingress takes precedence and
                # uses the private socket, and the port-zero fallback cannot expose a TCP app.
                connector = subprocess.Popen([
                    cloudflared_path(), "tunnel", "--config", str(settings), "--no-autoupdate",
                    "--url", "http://127.0.0.1:0",
                ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
                event(logger, "tunnel.started", "Cloudflare tunnel process started", pid=connector.pid, port=port)
                reader = Thread(target=_record_tunnel_output, args=(connector.stdout, url_file), daemon=True)
                reader.start()
                while not stop_file.exists():
                    if (status := connector.poll()) is not None:
                        event(logger, "tunnel.process_exited", "Cloudflare tunnel process exited",
                              level=logging.ERROR if status else logging.INFO, port=port, tunnel_status=status)
                        return status
                    sleep(0.25)
            return 0
        except KeyboardInterrupt:
            return 0
        finally:
            terminate(connector)
            if reader:
                reader.join()
            url_file.unlink(missing_ok=True)
            stop_file.unlink(missing_ok=True)


def ensure_connector(port):
    directory = _state_dir(port)
    url_file = directory / "url"
    with locked(directory / "control"):
        worker = None
        if not connector_active(port):
            (directory / "stop").unlink(missing_ok=True)
            url_file.unlink(missing_ok=True)
            with (directory / "cloudflared.log").open("w", encoding="utf-8") as log:
                worker = subprocess.Popen(
                    [sys.executable, "-m", "tradingagents.dashboard.tunnel", str(port), "--connector"],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                )
        deadline = monotonic() + 75
        try:
            while monotonic() < deadline:
                if worker and worker.poll() is not None:
                    break
                if connector_active(port):
                    try:
                        url = url_file.read_text(encoding="utf-8").strip()
                    except FileNotFoundError:
                        pass
                    else:
                        if _QUICK_URL.fullmatch(url):
                            if worker:
                                Thread(target=worker.wait, daemon=True).start()
                            return url
                sleep(0.25)
        except BaseException:
            terminate(worker)
            raise
        terminate(worker)
    raise ValueError(f"Cloudflare did not provide a tunnel URL. See {directory / 'cloudflared.log'}.")


def stop_connector(port):
    directory = _state_dir(port)
    if directory.is_dir():
        with locked(directory / "control"):
            if connector_active(port):
                (directory / "stop").touch()
                deadline = monotonic() + 10
                while connector_active(port):
                    if monotonic() >= deadline:
                        raise ValueError(f"Cloudflare did not stop. See {directory / 'cloudflared.log'}.")
                    sleep(0.25)
                print("Market Desk tunnel stopped.", flush=True)
                return 0
    print("No Market Desk tunnel is running.", flush=True)
    return 0


def main(port):
    env = {**os.environ, "TRADINGAGENTS_QUICK_TUNNEL": "1", _PASSWORD_NAME: tunnel_password()}
    server = None
    try:
        server = start_dashboard(port, env=env)
        wait_for_auth(server, port)
        event(logger, "tunnel.authentication_verified", "Market Desk requires sign-in on its private tunnel origin", port=port)
        try:
            url = ensure_connector(port)
        except (OSError, ValueError) as error:
            event(logger, "tunnel.failed", "Cloudflare could not connect", level=logging.ERROR, **exception_fields(error))
            print(f"{Redactor().text(str(error))} Market Desk is running at http://127.0.0.1:{port}/.", flush=True)
        else:
            print(f"Market Desk tunnel: {url}\nSign in as marketdesk using the tunnel password in .env.", flush=True)
        return server.wait()
    except KeyboardInterrupt:
        return 0
    finally:
        terminate(server)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("port", type=int)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--connector", action="store_true")
    actions.add_argument("--stop", action="store_true")
    args = parser.parse_args()
    configure_logging("launcher")
    try:
        action = stop_connector if args.stop else _run_connector if args.connector else main
        raise SystemExit(action(args.port))
    except (OSError, tarfile.TarError, ValueError) as error:
        event(logger, "tunnel.failed", "Market Desk tunnel could not start",
              level=logging.ERROR, **exception_fields(error, stack=True))
        raise SystemExit("Market Desk tunnel could not start. " + Redactor().text(str(error))) from None
