import base64
import secrets

from fastapi import FastAPI
from fastapi.testclient import TestClient

from tradingagents.dashboard import api
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
