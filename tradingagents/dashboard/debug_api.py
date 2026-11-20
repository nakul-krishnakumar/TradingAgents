"""HTTP tracing and authenticated access to Market Desk diagnostics."""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
from datetime import datetime
from time import monotonic
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query
from fastapi.exception_handlers import http_exception_handler, request_validation_exception_handler
from pydantic import BaseModel, ConfigDict, Field
from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse

from tradingagents.diagnostics import (
    diagnostic_context,
    elapsed_ms,
    event,
    event_handler,
    exception_fields,
    log_path,
    read_events,
    read_trace_headers,
    trace_id,
)

logger = logging.getLogger(__name__)


class RequestLogMiddleware:
    """Log the route template and complete response, including streams and errors."""

    def __init__(self, app, *, bridge=False):
        self.app = app
        self.bridge = bridge

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        context = read_trace_headers(Headers(scope=scope), inherited=self.bridge)
        if "request_id" in context:
            context["parent_request_id"] = context.pop("request_id")
        identifier = uuid4().hex
        scope.setdefault("state", {})["request_id"] = identifier
        start = monotonic()
        status, sent, interrupted, complete = None, 0, False, False

        async def respond(message):
            nonlocal status, sent, complete
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message)["X-Request-ID"] = identifier
            elif message["type"] == "http.response.body":
                sent += len(message.get("body", b""))
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body"):
                complete = True

        with diagnostic_context(request_id=identifier, **context):
            try:
                await self.app(scope, receive, respond)
            except asyncio.CancelledError:
                interrupted = not complete
                status = status or 499
                raise
            except Exception as exc:
                interrupted = True
                status = status or 500
                event(logger, "http.exception", "Request raised an unexpected error", level=logging.ERROR,
                      **exception_fields(exc, stack=True))
                raise
            finally:
                route = getattr(scope.get("route"), "path", None)
                if not route:
                    # Pre-routing errors and mount requests can contain user
                    # values in the URL. Save only a safe route family.
                    path = scope.get("path", "")
                    route = "/assets/*" if path.startswith("/assets/") else "/api/*" if path.startswith("/api/") else "(unmatched)"
                identifiers = {}
                if resource_id := trace_id(scope.get("path_params", {}).get("identifier")):
                    key = "run_id" if route.startswith("/api/jobs/") else "resource_id"
                    identifiers[key] = resource_id
                level = logging.ERROR if (status or 500) >= 500 else logging.WARNING if (status or 500) >= 400 or interrupted else logging.INFO
                event(logger, "http.request", "HTTP request finished", level=level,
                      method=scope["method"], route=route, status=status,
                      elapsed_ms=elapsed_ms(start), bytes_sent=sent, interrupted=interrupted, **identifiers)


async def validation_error(request, error):
    event(logger, "http.validation_failed", "API input failed validation", level=logging.WARNING,
          fields=[{"location": list(item["loc"]), "type": item["type"]} for item in error.errors()[:20]])
    return await request_validation_exception_handler(request, error)


async def handled_http_error(request, error):
    event(logger, "http.rejected", "API request could not be completed",
          level=logging.ERROR if error.status_code >= 500 else logging.WARNING,
          status=error.status_code, detail=error.detail if isinstance(error.detail, str) else None)
    return await http_exception_handler(request, error)


async def unexpected_http_error(request, _error):
    identifier = getattr(request.state, "request_id", "")
    return JSONResponse({"detail": "Market Desk hit an unexpected error.", "request_id": identifier},
                        status_code=500, headers={"X-Request-ID": identifier, "Cache-Control": "no-store"})


class BrowserEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=32, max_length=36)
    at: datetime
    kind: Literal["view", "click", "change", "submit", "error", "api_error", "dropped"]
    page: str = Field(pattern=r"^[a-z-]{1,32}$")
    control: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9_.:-]{1,100}$")
    detail: str | None = Field(default=None, max_length=1000)
    request_id: str | None = Field(default=None, max_length=36)
    status: int | None = Field(default=None, ge=100, le=599)


class BrowserBatch(BaseModel):
    session: str = Field(min_length=32, max_length=36)
    events: Annotated[list[BrowserEvent], Field(min_length=1, max_length=32)]


def diagnostics_router(results_dir):
    router = APIRouter(prefix="/api/diagnostics")

    def read(**filters):
        try:
            return read_events(log_path(results_dir), **filters)
        except (OSError, ValueError, sqlite3.Error) as exc:
            event(logger, "diagnostics.read_failed", "Could not read the event journal",
                  level=logging.ERROR, **exception_fields(exc, stack=True))
            raise HTTPException(503, "The system event log is temporarily unavailable.") from None

    @router.get("")
    def logs(
        before: int | None = Query(default=None, ge=1),
        level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] | None = None,
        service: str | None = Query(default=None, max_length=40),
        q: str | None = Query(default=None, max_length=200),
        trace: str | None = Query(default=None, max_length=36),
        issues: bool = False,
        omit_reads: bool = False,
        limit: int = Query(default=100, ge=1, le=200),
    ):
        if trace and not trace_id(trace):
            raise HTTPException(400, "Enter an ID from one of the log entries.")
        return read(before=before, level=level, service=service, query=q, issues=issues, trace=trace_id(trace),
                    omit_reads=omit_reads, limit=limit)

    @router.get("/download")
    def download(
        level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] | None = None,
        service: str | None = Query(default=None, max_length=40),
        q: str | None = Query(default=None, max_length=200),
        trace: str | None = Query(default=None, max_length=36),
        issues: bool = False,
        omit_reads: bool = False,
    ):
        from starlette.responses import StreamingResponse

        if trace and not trace_id(trace):
            raise HTTPException(400, "Enter an ID from one of the log entries.")
        entries = read(level=level, service=service, query=q, trace=trace_id(trace), omit_reads=omit_reads,
                       issues=issues, limit=5000)
        content = (json.dumps(row, ensure_ascii=False) + "\n" for row in reversed(entries["events"]))
        return StreamingResponse(content, media_type="application/x-ndjson", headers={
            "Content-Disposition": 'attachment; filename="market-desk-events.jsonl"',
        })

    @router.post("/browser", status_code=202)
    def browser_events(batch: BrowserBatch):
        if not trace_id(batch.session) or not all(trace_id(item.id) for item in batch.events):
            raise HTTPException(400, "Invalid browser event identifier.")
        for record in batch.events:
            event(logger, f"browser.{record.kind}", "Market Desk browser event",
                  level=logging.ERROR if record.kind == "error" else logging.WARNING if record.kind in {"api_error", "dropped"} else logging.INFO,
                  browser_event_id=trace_id(record.id), action_id=trace_id(record.id), session_id=trace_id(batch.session),
                  client_at=record.at.isoformat(), page=record.page, control=record.control, detail=record.detail,
                  related_request_id=trace_id(record.request_id), status=record.status)
        handler = event_handler()
        if handler is None or not handler.available:
            raise HTTPException(503, "Browser diagnostics could not be saved yet.")
        return {"accepted": len(batch.events)}

    return router
