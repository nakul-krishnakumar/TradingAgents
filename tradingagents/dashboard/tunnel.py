"""Start a local Market Desk and share it through an authenticated Quick Tunnel."""

from __future__ import annotations

import http.client
import logging
import os
import platform
import secrets
import shutil
import signal
import subprocess
import sys
import tarfile
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from time import monotonic, sleep
from urllib.request import urlopen

from dotenv import dotenv_values, set_key

from tradingagents.diagnostics import Redactor, configure_logging, event, exception_fields

_DOWNLOADS = "https://github.com/cloudflare/cloudflared/releases/latest/download"
_PASSWORD_NAME = "TRADINGAGENTS_TUNNEL_PASSWORD"
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


def wait_for_auth(server, port):
    deadline = monotonic() + 25
    while monotonic() < deadline and server.poll() is None:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
        try:
            connection.request("GET", "/api/settings")
            response = connection.getresponse()
            if response.status == 401 and response.getheader("WWW-Authenticate", "").startswith('Basic realm="Market Desk"'):
                return
            raise ValueError("Market Desk did not require authentication. The tunnel stayed closed.")
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


def _record_tunnel_output(stream):
    redact = Redactor()
    with stream:
        for line in stream:
            safe = redact.text(line.strip())
            if safe:
                event(logger, "tunnel.output", "Cloudflare tunnel diagnostic", detail=safe)
                print(safe, flush=True)


def main(port):
    cloudflared = cloudflared_path()
    password = tunnel_password()
    env = {**os.environ, "TRADINGAGENTS_QUICK_TUNNEL": "1", _PASSWORD_NAME: password}
    address = f"http://127.0.0.1:{port}"
    server = tunnel = reader = None

    def stop(*_):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    try:
        server = start_dashboard(port, env=env)
        wait_for_auth(server, port)
        event(logger, "tunnel.authentication_verified", "Market Desk requires sign-in before the tunnel opens", port=port)
        print("Open the HTTPS URL Cloudflare prints. Sign in as marketdesk using the tunnel password in .env.", flush=True)
        # Keep the Quick Tunnel independent of a named tunnel's configuration.
        with TemporaryDirectory() as folder:
            settings = Path(folder) / "cloudflared.yml"
            settings.write_text("{}\n", encoding="utf-8")
            tunnel = subprocess.Popen([
                cloudflared, "tunnel", "--config", str(settings), "--no-autoupdate", "--url", address,
            ], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
            event(logger, "tunnel.started", "Cloudflare tunnel process started", pid=tunnel.pid)
            reader = Thread(target=_record_tunnel_output, args=(tunnel.stdout,), daemon=True)
            reader.start()
            while server.poll() is None and tunnel.poll() is None:
                sleep(0.25)
        status = server.returncode if server.returncode is not None else tunnel.returncode
        event(logger, "tunnel.process_exited", "A Market Desk tunnel service exited",
              level=logging.ERROR if status else logging.INFO, dashboard_status=server.returncode, tunnel_status=tunnel.returncode)
        return status
    except KeyboardInterrupt:
        return 0
    finally:
        terminate(tunnel)
        terminate(server)
        if reader and reader.is_alive():
            reader.join(timeout=1)


if __name__ == "__main__":
    configure_logging("launcher")
    try:
        raise SystemExit(main(int(sys.argv[1])))
    except (OSError, tarfile.TarError, ValueError) as error:
        event(logger, "tunnel.failed", "Market Desk tunnel could not start",
              level=logging.ERROR, **exception_fields(error, stack=True))
        raise SystemExit("Market Desk tunnel could not start. " + Redactor().text(str(error))) from None
