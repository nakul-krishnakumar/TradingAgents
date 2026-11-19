"""Start a local Market Desk and share it through an authenticated Quick Tunnel."""

from __future__ import annotations

import http.client
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
from time import monotonic, sleep
from urllib.request import urlopen

from dotenv import dotenv_values, set_key

_DOWNLOADS = "https://github.com/cloudflare/cloudflared/releases/latest/download"
_PASSWORD_NAME = "TRADINGAGENTS_TUNNEL_PASSWORD"


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


def main(port):
    cloudflared = cloudflared_path()
    password = tunnel_password()
    env = {**os.environ, "TRADINGAGENTS_QUICK_TUNNEL": "1", _PASSWORD_NAME: password}
    address = f"http://127.0.0.1:{port}"
    server = tunnel = None

    def stop(*_):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    try:
        server = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "tradingagents.dashboard.api:app",
             "--host", "127.0.0.1", "--port", str(port), "--no-access-log"],
            env=env,
        )
        wait_for_auth(server, port)
        print("Open the HTTPS URL Cloudflare prints. Sign in as marketdesk using the tunnel password in .env.", flush=True)
        # Keep the Quick Tunnel independent of a named tunnel's configuration.
        with TemporaryDirectory() as folder:
            settings = Path(folder) / "cloudflared.yml"
            settings.write_text("{}\n", encoding="utf-8")
            tunnel = subprocess.Popen([
                cloudflared, "tunnel", "--config", str(settings), "--no-autoupdate", "--url", address,
            ])
            while server.poll() is None and tunnel.poll() is None:
                sleep(0.25)
        return server.returncode if server.returncode is not None else tunnel.returncode
    except KeyboardInterrupt:
        return 0
    finally:
        terminate(tunnel)
        terminate(server)


if __name__ == "__main__":
    try:
        raise SystemExit(main(int(sys.argv[1])))
    except (OSError, tarfile.TarError, ValueError) as error:
        raise SystemExit(f"Market Desk tunnel could not start. {error}") from None
