import logging
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from tradingagents.dashboard.debug_api import (
    RequestLogMiddleware,
    diagnostics_router,
    handled_http_error,
    unexpected_http_error,
    validation_error,
)
from tradingagents.dashboard.jobs import JobStore
from tradingagents.diagnostics import (
    EventHandler,
    Redactor,
    diagnostic_context,
    event,
    read_events,
    submit_traced,
)


@pytest.fixture
def journal(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADINGAGENTS_LOG_DIR", str(tmp_path))
    handler = EventHandler("market-desk", tmp_path / "events.sqlite3")
    root = logging.getLogger()
    root.addHandler(handler)
    level = root.level
    root.setLevel(logging.INFO)
    try:
        yield handler.path
    finally:
        root.removeHandler(handler)
        handler.close()
        root.setLevel(level)


def test_requests_browser_events_and_exceptions_are_correlated(journal):
    app = FastAPI()
    app.add_middleware(RequestLogMiddleware)
    app.add_exception_handler(Exception, unexpected_http_error)
    app.add_exception_handler(RequestValidationError, validation_error)
    app.add_exception_handler(StarletteHTTPException, handled_http_error)
    app.include_router(diagnostics_router(journal.parent))
    session, action, run = (uuid4().hex for _ in range(3))
    logger = logging.getLogger("test.research")

    class Body(BaseModel):
        amount: int

    @app.post("/api/sample/{identifier}")
    def success(identifier: str, body: Body):
        with ThreadPoolExecutor(max_workers=1) as pool:
            submit_traced(pool, event, logger, "test.job", "Sample research started", run_id=run).result()
        return {"amount": body.amount}

    @app.get("/api/error")
    def broken():
        raise RuntimeError("Authorization: Bearer private-value-no-standard-prefix")

    @app.get("/api/limit")
    def rate_limit():
        raise HTTPException(429, "Rate limited")

    client = TestClient(app, raise_server_exceptions=False)
    headers = {"X-MarketDesk-Session": session, "X-MarketDesk-Action": action,
               "X-MarketDesk-Run": uuid4().hex}
    result = client.post("/api/sample/secret-path?api_key=private-query", json={"amount": 25}, headers=headers)
    assert result.status_code == 200
    request_id = result.headers["X-Request-ID"]
    body = {"session": session, "events": [{"id": action, "at": "2026-11-20T12:00:00Z",
                                           "kind": "click", "page": "daily", "control": "daily.check-now"}]}
    for _ in range(2):
        assert client.post("/api/diagnostics/browser", json=body).status_code == 202

    follow = client.get("/api/diagnostics", params={"trace": action}).json()["events"]
    assert sum(row["event"] == "browser.click" for row in follow) == 1
    assert any(row["event"] == "test.job" and row["fields"]["request_id"] == request_id and row["fields"]["run_id"] == run
               for row in follow)
    assert any(row["event"] == "http.request" and row["fields"]["route"] == "/api/sample/{identifier}"
               for row in follow)

    failed = client.get("/api/error")
    assert failed.status_code == 500
    assert failed.json()["request_id"] == failed.headers["X-Request-ID"]
    assert client.get("/api/limit").status_code == 429
    assert client.post("/api/sample/another", json={"amount": "malformed-private-body"}).status_code == 422
    issues = client.get("/api/diagnostics", params={"issues": True}).json()["events"]
    assert any(row["event"] == "http.exception" and row["fields"]["frames"] for row in issues)
    assert any(row["event"] == "http.validation_failed" for row in issues)
    assert any(row["event"] == "http.rejected" and row["fields"]["status"] == 429 for row in issues)
    raw = client.get("/api/diagnostics/download").text
    for secret in ("secret-path", "private-query", "private-value-no-standard-prefix", "malformed-private-body"):
        assert secret not in raw


def test_concurrent_writers_keep_rows_and_retain_problems_separately(tmp_path):
    path = tmp_path / "events.sqlite3"
    first = EventHandler("market-desk", path, limit=50)
    second = EventHandler("codex-bridge", path, limit=50)
    request_id = uuid4().hex

    def write(handler, count, level):
        with diagnostic_context(request_id=request_id):
            for number in range(count):
                record = logging.LogRecord("test", level, __file__, 1, "row %d", (number,), None)
                handler.handle(record)

    with ThreadPoolExecutor(max_workers=2) as pool:
        normal = pool.submit(write, first, 150, logging.INFO)
        problems = pool.submit(write, second, 9, logging.ERROR)
        normal.result()
        problems.result()
    first._prune()
    first.close()
    second.close()

    rows = read_events(path, trace=request_id, limit=100)["events"]
    assert len(rows) == 49
    assert sum(row["level"] == "ERROR" for row in rows) == 9
    assert len({row["id"] for row in rows}) == len(rows)
    assert path.stat().st_mode & 0o777 == 0o600


def test_worker_keeps_origin_and_continues_after_a_research_failure(journal, tmp_path, monkeypatch):
    jobs = JobStore({"results_dir": tmp_path, "llm_provider": "openai"})
    jobs.start()
    request_id, action_id = uuid4().hex, uuid4().hex

    def analyze(job, _trace):
        if job["params"]["symbol"] == "FAIL":
            raise ValueError("The provider returned an unusable result.")

    monkeypatch.setattr(jobs, "_research", analyze)
    with diagnostic_context(request_id=request_id, action_id=action_id):
        failed = jobs.create("research", {"symbol": "FAIL"})
        completed = jobs.create("research", {"symbol": "OK"})
    jobs.queue.join()

    assert jobs.read(failed["id"])["status"] == "failed"
    assert jobs.read(completed["id"])["status"] == "completed"
    for job, outcome in ((failed, "research.failed"), (completed, "research.completed")):
        events = read_events(journal, trace=job["id"])["events"]
        assert any(entry["event"] == outcome and entry["fields"]["request_id"] == request_id
                   and entry["fields"]["action_id"] == action_id for entry in events)


def test_redactor_handles_credentials_across_token_boundaries():
    secret = "example copied credential longer than one token"
    scrub = Redactor({"TRADINGAGENTS_TUNNEL_PASSWORD": secret})
    message = "A visible introduction. " * 15 + secret + " Authorization: Bearer opaque-no-prefix " + "A visible sentence. " * 15
    emitted, tail = "", ""
    for start in range(0, len(message), 7):
        safe, tail = scrub.stream(tail + message[start:start + 7])
        emitted += safe
    emitted += scrub.text(tail)
    assert secret not in emitted
    assert "opaque-no-prefix" not in emitted
    assert "A visible introduction." in emitted
    assert emitted.count("[REDACTED]") == 2
