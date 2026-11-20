import base64
import os
import secrets
import subprocess
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from tradingagents.dashboard import api, tunnel
from tradingagents.dashboard.tunnel import tunnel_password


def test_tunnel_requires_authentication_and_own_origin(monkeypatch):
    password = secrets.token_urlsafe(24)
    monkeypatch.setattr(api, "TUNNEL_MODE", True)
    monkeypatch.setattr(api, "TUNNEL_AUTH", base64.b64encode(f"marketdesk:{password}".encode()))
    app = FastAPI()
    app.middleware("http")(api.local_requests)
    app.get("/panel")(lambda: {"open": True})
    app.post("/panel")(lambda: {"updated": True})
    origin = "https://desk-example.trycloudflare.com"

    with TestClient(app, base_url=origin) as client:
        challenge = client.get("/panel")
        assert challenge.status_code == 401
        assert challenge.headers["WWW-Authenticate"] == api.TUNNEL_CHALLENGE
        assert client.get("/panel", auth=("marketdesk", "wrong")).status_code == 401
        assert client.get("/panel", headers={"Host": "127.0.0.1"}).status_code == 401
        auth = ("marketdesk", password)
        authorized = client.get("/panel", auth=auth)
        assert authorized.status_code == 200
        assert authorized.headers["Cache-Control"] == "no-store"
        assert client.post("/panel", auth=auth, headers={"Origin": origin}, json={}).status_code == 200
        assert client.post("/panel", auth=auth, headers={"Origin": "https://other.trycloudflare.com"}, json={}).status_code == 403


def test_generated_password_stays_in_dotenv(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    first = tunnel_password()
    assert len(first) >= 16
    assert tunnel_password() == first
    assert first in (tmp_path / ".env").read_text(encoding="utf-8")
    assert first not in capsys.readouterr().out


def test_tunnel_uses_user_defined_password(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    password = secrets.token_urlsafe(24) + "#${TUNNEL_TEST_LITERAL}"
    config = f"TRADINGAGENTS_TUNNEL_PASSWORD='{password}'\n"
    path = tmp_path / ".env"
    path.write_text(config, encoding="utf-8")

    assert tunnel_password() == password
    assert path.read_text(encoding="utf-8") == config
    assert not capsys.readouterr().out


def test_detached_connector_is_reused_and_can_be_stopped(monkeypatch, tmp_path):
    repo = Path(tunnel.__file__).resolve().parents[2]
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PYTHONPATH", str(repo))
    monkeypatch.setenv("TRADINGAGENTS_RESULTS_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    executable = tmp_path / "cloudflared"
    executable.write_text(
        "#!/usr/bin/env python3\n"
        "import json, sys, time\n"
        "from pathlib import Path\n"
        "args = sys.argv\n"
        "config = json.loads(Path(args[args.index('--config') + 1]).read_text())\n"
        "assert config['ingress'] == [{'service': 'unix:.venv/market-desk-tunnels/8765/origin.sock'}]\n"
        "assert args[args.index('--url') + 1] == 'http://127.0.0.1:0'\n"
        "with open('connector-starts', 'a') as starts: starts.write('started\\n')\n"
        "print('https://desk-reuse-example.trycloudflare.com', flush=True)\n"
        "while True: time.sleep(1)\n",
        encoding="utf-8",
    )
    executable.chmod(0o700)
    tunnel._state_dir(8765).mkdir(parents=True)
    try:
        original = subprocess.run([
            sys.executable, "-c",
            "from tradingagents.dashboard.tunnel import ensure_connector; print(ensure_connector(8765))",
        ], capture_output=True, text=True, check=True, timeout=10)
        url = original.stdout.strip()
        assert tunnel.connector_active(8765)
        assert url == "https://desk-reuse-example.trycloudflare.com"
        assert tunnel.ensure_connector(8765) == url
        assert (tmp_path / "connector-starts").read_text() == "started\n"
    finally:
        tunnel.stop_connector(8765)
    assert not tunnel.connector_active(8765)
    assert not (tunnel._state_dir(8765) / "url").exists()
