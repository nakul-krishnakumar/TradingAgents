"""Structured diagnostics shared by the dashboard, workers and model bridge."""

from __future__ import annotations

import base64
import json
import logging
import math
import os
import re
import sqlite3
import sys
import traceback
from collections.abc import Mapping
from contextlib import closing, contextmanager, suppress
from contextvars import ContextVar, copy_context
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic
from urllib.parse import quote, quote_plus, urlsplit

_CONTEXT: ContextVar[dict | None] = ContextVar("tradingagents_diagnostics", default=None)
_TRACE_HEADERS = {
    "session_id": "X-MarketDesk-Session",
    "action_id": "X-MarketDesk-Action",
    "request_id": "X-MarketDesk-Request",
    "run_id": "X-MarketDesk-Run",
    "scan_id": "X-MarketDesk-Scan",
    "call_id": "X-MarketDesk-Call",
}
_ID = re.compile(r"(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})", re.I)
_SECRET_NAME = re.compile(
    r"(?:^|_)(?:api_?key|access_key(?:_id)?|(?:bridge|private)_key|pass(?:word|wd)?|secret|"
    r"token|credential(?:s)?|authorization|(?:set_)?cookie|signature)(?:_|$)", re.I
)
_SECRET_TEXT = re.compile(
    r"(?i)(?:(?:basic|bearer)[ \t]+[A-Za-z0-9._~+/=-]{4,}|"
    r"https?://[^\s/@<>]+:[^\s/@<>]+@|"
    r"\b(?:set[-_])?cookie\s*[\"']?\s*[:=][^\r\n]*|"
    r"(?<=\b)[A-Z0-9_]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|"
    r"secret|bridge[_-]?key|authorization|cookie|signature)\s*[\"']?\s*[:=]\s*"
    r"(?:\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|(?:basic|bearer)[ \t]+[A-Za-z0-9._~+/=-]+|[^\s,;\]\}\"'<>]+)|"
    r"\b(?:sk-|xox[baprs]-|gh[pousr]_|github_pat_|AIza)[A-Za-z0-9_-]{12,}|"
    r"\b(?:AKIA|ASIA)[A-Z0-9]{16}|"
    r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"
)
_URL_QUERY = re.compile(r"(https?://[^\s<>\"'?]+)\?[^\s<>\"']+", re.I)
_HTTP_CLIENT = re.compile(r'^HTTP Request: ([A-Z]+) (\S+) "HTTP/\S+ (\d{3})\b')
_REDACTED = "[REDACTED]"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    level TEXT NOT NULL,
    severity INTEGER NOT NULL,
    service TEXT NOT NULL,
    logger TEXT NOT NULL,
    event TEXT NOT NULL,
    message TEXT NOT NULL,
    fields TEXT NOT NULL,
    request_id TEXT,
    run_id TEXT,
    scan_id TEXT,
    browser_event_id TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS events_severity ON events(severity, id);
CREATE INDEX IF NOT EXISTS events_request ON events(request_id, id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_scan ON events(scan_id, id) WHERE scan_id IS NOT NULL;
"""


def trace_id(value):
    return value.lower() if isinstance(value, str) and _ID.fullmatch(value) else None


def trace_headers(**fields):
    current = _CONTEXT.get() or {}
    return {header: value for key, header in _TRACE_HEADERS.items()
            if (value := trace_id(fields.get(key) or current.get(key)))}


def read_trace_headers(headers, *, inherited=False):
    accepted = _TRACE_HEADERS if inherited else ("session_id", "action_id")
    return {key: value for key in accepted if (value := trace_id(headers.get(_TRACE_HEADERS[key])))}


def trace_context():
    return dict(_CONTEXT.get() or {})


@contextmanager
def diagnostic_context(**fields):
    token = _CONTEXT.set({**trace_context(), **{key: value for key, value in fields.items() if value is not None}})
    try:
        yield
    finally:
        _CONTEXT.reset(token)


def submit_traced(pool, operation, *args, **kwargs):
    return pool.submit(copy_context().run, operation, *args, **kwargs)


def elapsed_ms(started):
    return round((monotonic() - started) * 1000, 1)


def event(logger, name, message, *, level=logging.INFO, **fields):
    logger.log(level, message, extra={"event_name": name, "event_fields": fields})


def exception_fields(error, *, stack=False):
    fields = {"error_type": type(error).__name__, "error": str(error)}
    status = getattr(error, "status_code", None)
    if not isinstance(status, int):
        status = getattr(getattr(error, "response", None), "status_code", None)
    if not isinstance(status, int):
        status = getattr(error, "status", None)
    if not isinstance(status, int):
        status = getattr(error, "code", None)
    if isinstance(status, int) and 100 <= status <= 599:
        fields["status"] = status
    for field in ("code", "request_id"):
        value = getattr(error, field, None)
        if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", value):
            fields["provider_" + field] = value
    if stack:
        fields["frames"] = [f"{frame.filename}:{frame.lineno} in {frame.name}"
                            for frame in traceback.extract_tb(error.__traceback__)[-28:]]
    return fields


class Redactor:
    """Redact credentials before persistence, including values from the live environment."""

    def __init__(self, env=None):
        env = os.environ if env is None else env
        values = set()
        for name, value in env.items():
            if _SECRET_NAME.search(name) and len(value.strip()) >= 4:
                values.update((value, quote(value, safe=""), quote_plus(value), json.dumps(value, ensure_ascii=False)[1:-1]))
        if password := env.get("TRADINGAGENTS_TUNNEL_PASSWORD"):
            values.add(base64.b64encode(f"marketdesk:{password}".encode()).decode())
        self.known = re.compile("|".join(re.escape(value) for value in sorted(values, key=len, reverse=True))) if values else None
        self.suffix = max(96, max(map(len, values), default=0) + 16)

    def text(self, text):
        if self.known:
            text = self.known.sub(_REDACTED, text)
        text = _SECRET_TEXT.sub(_REDACTED, text)
        return _URL_QUERY.sub(r"\1?[REDACTED]", text)

    def value(self, value, depth=0):
        if depth > 7:
            return "[nested values omitted]"
        if isinstance(value, str):
            return self.text(value)[:8000]
        if isinstance(value, Mapping):
            return {self.text(str(key))[:150]: _REDACTED if _SECRET_NAME.search(str(key).replace("-", "_"))
                    else self.value(item, depth + 1) for key, item in list(value.items())[:100]}
        if isinstance(value, (list, tuple)):
            return [self.value(item, depth + 1) for item in value[:150]]
        if value is None or isinstance(value, (bool, int)):
            return value
        if isinstance(value, float):
            return value if math.isfinite(value) else None
        return self.text(str(value))[:8000]

    def stream(self, value, *, final=False):
        """Hold unfinished words and any match that crosses the emitted boundary."""
        if final:
            return self.text(value), ""
        end = len(value) - self.suffix
        if end <= 0:
            return "", value
        # Keeping a suffix preserves split environment values and header names.
        # Long unbroken tokens stay buffered until their kind can be identified.
        cut = max(value.rfind(" ", 0, end), value.rfind("\n", 0, end), value.rfind("\t", 0, end)) + 1
        for pattern in (self.known, _SECRET_TEXT, _URL_QUERY):
            if pattern and cut:
                for match in pattern.finditer(value):
                    if match.start() < cut < match.end():
                        cut = match.start()
                        break
        return self.text(value[:cut]), value[cut:]


def log_path(results_dir=None):
    if directory := os.getenv("TRADINGAGENTS_LOG_DIR"):
        return Path(directory).expanduser() / "events.sqlite3"
    results = results_dir or os.getenv("TRADINGAGENTS_RESULTS_DIR") or Path.home() / ".tradingagents" / "logs"
    return Path(results).expanduser() / "dashboard" / "diagnostics" / "events.sqlite3"


class EventHandler(logging.Handler):
    """One durable SQLite writer per process. WAL allows simultaneous readers."""

    def __init__(self, service, path, limit=250_000):
        super().__init__(logging.INFO)
        self.service = service
        self.path = Path(path)
        self.limit = limit
        self.redactor = Redactor()
        self.database = None
        self.written = 0
        self.available = False

    def _open(self):
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path.touch(mode=0o600, exist_ok=True)
        self.path.chmod(0o600)
        database = sqlite3.connect(self.path, timeout=2, isolation_level=None, check_same_thread=False)
        try:
            database.execute("PRAGMA journal_mode=WAL")
            database.execute("PRAGMA journal_size_limit=8388608")
            database.executescript(_SCHEMA)
        except sqlite3.Error:
            database.close()
            raise
        self.database = database

    def emit(self, record):
        row = None
        try:
            fields = {**trace_context(), **getattr(record, "event_fields", {})}
            if record.exc_info and record.exc_info[1] is not None:
                fields.update(exception_fields(record.exc_info[1], stack=True))
            name = getattr(record, "event_name", "python.message")
            level, message = record.levelno, record.getMessage()
            if outgoing := _HTTP_CLIENT.match(message):
                method, url, status = outgoing.groups()
                fields.update(method=method, host=urlsplit(url).hostname, status=int(status))
                name, message = "http.upstream", "Upstream HTTP response"
                if int(status) >= 400:
                    level = max(level, logging.WARNING)
            fields = self.redactor.value(fields)
            row = {
                "at": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
                "level": logging.getLevelName(level), "service": self.service, "logger": record.name,
                "event": name, "message": self.redactor.text(message)[:8000], "fields": fields,
            }
            if self.database is None:
                self._open()
            self.database.execute(
                """INSERT OR IGNORE INTO events
                   (at, level, severity, service, logger, event, message, fields, request_id, run_id, scan_id, browser_event_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (row["at"], row["level"], int(level >= logging.WARNING), self.service,
                 row["logger"], row["event"], row["message"], json.dumps(fields, ensure_ascii=False, allow_nan=False),
                 fields.get("request_id"), fields.get("run_id"), fields.get("scan_id"), fields.get("browser_event_id")),
            )
            self.written += 1
            if self.written == 1 or self.written % 256 == 0:
                self._prune()
            self.available = True
        except (OSError, sqlite3.Error, TypeError, ValueError) as exc:
            # A full disk or an unavailable DB must not stop research or order
            # handling. Do not let logging.handleError dump the raw LogRecord.
            self.available = False
            with suppress(OSError, UnicodeError):
                print(json.dumps({"event": "diagnostics.write_failed", "error": type(exc).__name__,
                                  "record": row}, ensure_ascii=False), file=sys.stderr, flush=True)

    def _prune(self):
        issue_limit = max(1, self.limit // 5)
        for severity, limit in ((0, self.limit - issue_limit), (1, issue_limit)):
            self.database.execute(
                """DELETE FROM events WHERE severity = ? AND id <= (
                    SELECT id FROM events WHERE severity = ? ORDER BY id DESC LIMIT 1 OFFSET ?
                )""", (severity, severity, limit),
            )

    def close(self):
        with self.lock:
            if self.database is not None:
                self.database.close()
                self.database = None
        super().close()


class _SafeConsole(logging.Formatter):
    def __init__(self, formatter, redactor):
        super().__init__()
        self.formatter = formatter or logging.Formatter()
        self.redactor = redactor

    def format(self, record):
        return self.redactor.text(self.formatter.format(record))


def event_handler():
    return next((item for item in logging.getLogger().handlers if isinstance(item, EventHandler)), None)


def configure_logging(service, results_dir=None):
    root = logging.getLogger()
    if handler := event_handler():
        return handler.path
    try:
        limit = max(1000, int(os.getenv("TRADINGAGENTS_LOG_MAX_EVENTS", "250000")))
    except ValueError:
        limit = 250_000
    handler = EventHandler(service, log_path(results_dir), limit)
    root.setLevel(min(root.level, logging.INFO))
    root.addHandler(handler)
    # Uvicorn's default logger does not propagate to the root.
    uvicorn = logging.getLogger("uvicorn")
    if not uvicorn.propagate:
        uvicorn.addHandler(handler)
    for target in (root, uvicorn, logging.getLogger("uvicorn.error")):
        for console in target.handlers:
            if isinstance(console, logging.StreamHandler):
                console.setFormatter(_SafeConsole(console.formatter, handler.redactor))
    logging.captureWarnings(True)
    event(logging.getLogger(__name__), "diagnostics.started", "Diagnostic logging started", max_events=limit)
    return handler.path


def read_events(path, *, before=None, level=None, service=None, query=None, issues=False, trace=None,
                omit_reads=False, limit=100):
    path = Path(path)
    if not path.is_file():
        return {"events": [], "next": None}
    conditions, args = [], []
    for expression, value in (("id < ?", before), ("level = ?", level), ("service = ?", service)):
        if value is not None:
            conditions.append(expression)
            args.append(value)
    if issues:
        conditions.append("severity = 1")
    if omit_reads:
        conditions.append("NOT (event = 'http.request' AND severity = 0 AND json_extract(fields, '$.method') = 'GET')")
    if trace:
        conditions.append("(request_id = ? OR run_id = ? OR scan_id = ? OR instr(fields, ?) > 0)")
        args.extend([trace] * 4)
    if query:
        conditions.append("instr(lower(event || ' ' || message || ' ' || logger || ' ' || fields), lower(?)) > 0")
        args.append(query)
    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)) as database:
        database.row_factory = sqlite3.Row
        rows = database.execute(
            "SELECT id, at, level, service, logger, event, message, fields FROM events" + where
            + " ORDER BY id DESC LIMIT ?", (*args, limit + 1),
        ).fetchall()
    items = [{**row, "fields": json.loads(row["fields"])} for row in rows[:limit]]
    return {"events": items, "next": items[-1]["id"] if len(rows) > limit else None}


if __name__ == "__main__":
    # run.sh can record setup failures before the project dependencies exist.
    try:
        from dotenv import load_dotenv
    except ImportError:
        pass
    else:
        load_dotenv(Path.cwd() / ".env")
        load_dotenv(Path.cwd() / ".env.enterprise")
    stage, exit_status = sys.argv[1], int(sys.argv[2])
    bootstrap_logger = logging.getLogger("tradingagents.bootstrap")
    configure_logging("launcher")
    event(bootstrap_logger, "launcher.bootstrap_failed" if exit_status else "launcher.bootstrap",
          "Market Desk setup failed" if exit_status else "Market Desk setup phase",
          level=logging.ERROR if exit_status else logging.INFO, stage=stage, exit_code=exit_status)
