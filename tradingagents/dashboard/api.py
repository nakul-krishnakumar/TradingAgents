"""Loopback API. Provider credentials stay in the Python process."""

from __future__ import annotations

import base64
import hmac
import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import date as calendar_date
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from cli.prompts import detect_asset_type, parse_analysis_date
from tradingagents.backtest import iter_grid
from tradingagents.dataflows.config import run_config
from tradingagents.dataflows.date_window import get_current_date
from tradingagents.dataflows.files import locked
from tradingagents.default_config import build_default_config
from tradingagents.diagnostics import configure_logging, event, exception_fields, submit_traced
from tradingagents.memory import TradingMemoryLog
from tradingagents.reporting import research_summary

from .codex_service import managed_bridge
from .daily_desk import DailyBudget, DailyDesk
from .daily_paper import AutoTradeSettings
from .debug_api import (
    RequestLogMiddleware,
    diagnostics_router,
    handled_http_error,
    unexpected_http_error,
    validation_error,
)
from .jobs import BacktestRequest, JobStore, ResearchRequest, provider_status, validate_analysts
from .market import (
    DEFAULTS,
    KINDS,
    chart_data,
    exchange_for,
    instrument,
    kind_for,
    resolve_symbol,
    search_funds,
    search_yahoo,
)
from .model_log import MODEL_LOG, model_log_lines, read_model_log
from .screener import quick_search_bonds
from .workspace_api import workspace_router

logger = logging.getLogger(__name__)
CONFIG = build_default_config()
JOBS = JobStore(CONFIG)
DAILY = DailyDesk(CONFIG)
DIST = Path(__file__).resolve().parents[2] / "web" / "dist"
SAVED = Path(CONFIG["results_dir"]) / "reports"
JOB_ID = re.compile(r"[a-f0-9]{32}")
REPORT_ID = re.compile(r"(?P<symbol>[A-Za-z0-9._^=+\-]{1,32})_(?P<day>\d{8})_\d{6}")
LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")
TUNNEL_MODE = os.getenv("TRADINGAGENTS_QUICK_TUNNEL") == "1"
TUNNEL_PASSWORD = os.getenv("TRADINGAGENTS_TUNNEL_PASSWORD", "")
if TUNNEL_MODE and len(TUNNEL_PASSWORD) < 16:
    raise RuntimeError("Tunnel mode requires TRADINGAGENTS_TUNNEL_PASSWORD in .env with at least 16 characters.")
TUNNEL_AUTH = base64.b64encode(f"marketdesk:{TUNNEL_PASSWORD}".encode()) if TUNNEL_MODE else None
TUNNEL_CHALLENGE = 'Basic realm="Market Desk", charset="UTF-8"'


@asynccontextmanager
async def lifespan(_app):
    configure_logging("market-desk", CONFIG["results_dir"])
    event(logger, "service.starting", "Starting the Market Desk API", tunnel=TUNNEL_MODE)
    JOBS.directory.mkdir(parents=True, exist_ok=True)
    with locked(JOBS.directory / "worker", wait=False) as acquired:
        if not acquired:
            raise RuntimeError("A dashboard process already owns this results directory.")
        with managed_bridge(CONFIG):
            JOBS.start()
            DAILY.start()
            event(logger, "service.ready", "Market Desk and the daily scheduler are ready", scheduled=DAILY.enabled)
            try:
                yield
            finally:
                DAILY.stop()
                event(logger, "service.stopped", "Market Desk API stopped")


app = FastAPI(title="TradingAgents Dashboard", lifespan=lifespan, docs_url=None, redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=4096, compresslevel=4)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=[
    "127.0.0.1", "localhost", "[::1]", *(["*.trycloudflare.com"] if TUNNEL_MODE else []),
])


def origin_allowed(origin: str, host: str | None) -> bool:
    try:
        parsed = urlsplit(origin)
        if parsed.hostname in LOCAL_HOSTS:
            return not (TUNNEL_MODE and host and host.endswith(".trycloudflare.com"))
        return bool(TUNNEL_MODE and host and host.endswith(".trycloudflare.com") and parsed.scheme == "https"
                    and parsed.hostname == host and parsed.port in (None, 443))
    except ValueError:
        return False


@app.middleware("http")
async def local_requests(request: Request, call_next):
    if TUNNEL_AUTH is not None:
        scheme, _, supplied = request.headers.get("authorization", "").partition(" ")
        if scheme.casefold() != "basic" or not hmac.compare_digest(supplied.strip().encode(), TUNNEL_AUTH):
            event(logger, "http.authentication_failed", "Tunnel sign-in was rejected", level=logging.WARNING)
            return JSONResponse({"detail": "Sign in to Market Desk."}, status_code=401, headers={
                "WWW-Authenticate": TUNNEL_CHALLENGE, "Cache-Control": "no-store",
            })
    if request.method in ("POST", "DELETE"):
        origin = request.headers.get("origin")
        if origin and not origin_allowed(origin, request.url.hostname):
            event(logger, "http.origin_rejected", "An API write came from another origin", level=logging.WARNING)
            return JSONResponse({"detail": "Use the Market Desk page to start a run."}, status_code=403)
        if request.method == "POST" and request.headers.get("content-type", "").split(";")[0] != "application/json":
            event(logger, "http.content_type_rejected", "An API write was missing its JSON content type", level=logging.WARNING)
            return JSONResponse({"detail": "Send a JSON request."}, status_code=415)
    response = await call_next(request)
    if TUNNEL_MODE or request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


app.add_middleware(RequestLogMiddleware)
app.add_exception_handler(StarletteHTTPException, handled_http_error)
app.add_exception_handler(RequestValidationError, validation_error)
app.add_exception_handler(Exception, unexpected_http_error)
app.include_router(workspace_router(CONFIG))
app.include_router(diagnostics_router(CONFIG["results_dir"]))


def _read_job(identifier: str) -> dict:
    if not JOB_ID.fullmatch(identifier):
        raise HTTPException(404, "Run not found.")
    try:
        return JOBS.read(identifier)
    except FileNotFoundError as exc:
        raise HTTPException(404, "Run not found.") from exc


def _validate(call, *args):
    try:
        return call(*args)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@app.get("/api/settings")
def settings():
    return {"providers": provider_status(CONFIG), "today": get_current_date(), "watchlist": DEFAULTS}


@app.get("/api/daily")
def daily_trading(day: calendar_date | None = None):
    return DAILY.view(day.isoformat() if day else None)


@app.post("/api/daily/budget")
def daily_budget(request: DailyBudget):
    return DAILY.set_budget(request.budget)


@app.post("/api/daily/auto-trade")
def daily_auto_trade(request: AutoTradeSettings):
    return _validate(DAILY.set_auto_trade, request)


@app.post("/api/daily/scan", status_code=202)
def daily_scan():
    return {"accepted": DAILY.enqueue("scan")}


@app.post("/api/daily/replay", status_code=202)
def daily_replay():
    if not DAILY.view()["candidates"]:
        raise HTTPException(400, "Scan a verified trading session to build the replay watchlist.")
    return {"accepted": DAILY.enqueue("replay")}


@app.get("/api/daily/chart")
def daily_chart(symbol: str, day: calendar_date):
    return DAILY.chart(_validate(resolve_symbol, symbol), day.isoformat())


@app.get("/api/daily/model-log")
def daily_model_log(day: calendar_date, offset: int = Query(default=0, ge=0)):
    return _validate(read_model_log, DAILY.path(day.isoformat(), MODEL_LOG), offset)


@app.get("/api/daily/model-log/download")
def daily_model_log_download(day: calendar_date):
    path = DAILY.path(day.isoformat(), MODEL_LOG)
    if not path.is_file():
        raise HTTPException(404, "No model log was recorded for this session.")
    return StreamingResponse(model_log_lines(path), media_type="application/x-ndjson", headers={
        "Content-Disposition": f'attachment; filename="daily-model-log-{day.isoformat()}.jsonl"',
    })


@app.get("/api/search")
def search(q: str = Query(min_length=1, max_length=100), mode: str = "all"):
    query = q.strip()
    if not query:
        return {"results": [], "unavailable": []}
    lower = query.casefold()
    results = [item for item in DEFAULTS if all(term in f"{item['symbol']} {item['name']}".casefold()
                                               for term in lower.split())
               and (mode == "all" or (item["kind"] == "fund") == (mode == "funds"))]
    try:
        symbol = resolve_symbol(query)
        if symbol.startswith(("AMFI-", "^")) or "." in symbol or "-" in symbol:
            kind = kind_for(symbol)
            if (mode == "all" or (kind == "fund") == (mode == "funds")) and symbol not in {r["symbol"] for r in results}:
                results.append(instrument(symbol, symbol, kind, exchange_for(symbol)))
    except ValueError:
        pass

    unavailable = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        sources = {}
        if mode in ("all", "listed"):
            sources[submit_traced(pool, search_yahoo, query)] = "Yahoo Finance search"
        if mode in ("all", "funds"):
            sources[submit_traced(pool, search_funds, query, get_current_date())] = "AMFI search"
        if mode == "bonds" or (mode == "all" and len(query) >= 3):
            sources[submit_traced(pool, quick_search_bonds, query, get_current_date())] = "NSE debt directory"
        for future, source in sources.items():
            try:
                results.extend(future.result())
            except Exception as exc:
                event(logger, "data.search_failed", "An investment search source failed",
                      level=logging.WARNING, source=source, **exception_fields(exc))
                unavailable.append(source)
    deduplicated = {item["symbol"]: item for item in results}
    selected = list(deduplicated.values())
    if mode == "bonds":
        selected = [item for item in selected if item["kind"] == "bond"]
    return {"results": selected[:20], "unavailable": unavailable}


@app.get("/api/chart")
def chart(symbol: str, date: str | None = None, kind: str | None = None):
    ticker = _validate(resolve_symbol, symbol)
    day = _validate(parse_analysis_date, date or get_current_date())
    if kind and kind not in KINDS:
        raise HTTPException(400, "Unknown instrument type.")
    try:
        with run_config(CONFIG):
            return chart_data(ticker, day, CONFIG, kind)
    except Exception as exc:
        event(logger, "data.chart_failed", "A price chart could not be loaded",
              level=logging.WARNING, symbol=ticker, date=day, **exception_fields(exc))
        detail = str(exc) if isinstance(exc, ValueError) else f"Price history for {ticker} is temporarily unavailable."
        raise HTTPException(503, detail) from None


@app.get("/api/jobs")
def jobs():
    return JOBS.list_jobs()


@app.get("/api/jobs/{identifier}")
def job(identifier: str):
    return _read_job(identifier)


@app.get("/api/jobs/{identifier}/model-log")
def model_log(identifier: str, offset: int = Query(default=0, ge=0)):
    _read_job(identifier)
    return _validate(read_model_log, JOBS.directory / identifier / MODEL_LOG, offset)


@app.get("/api/jobs/{identifier}/model-log/download")
def download_model_log(identifier: str):
    _read_job(identifier)
    path = JOBS.directory / identifier / MODEL_LOG
    if not path.is_file():
        raise HTTPException(404, "Model log unavailable.")
    return StreamingResponse(model_log_lines(path), media_type="application/x-ndjson", headers={
        "Content-Disposition": f'attachment; filename="model-log-{identifier}.jsonl"',
    })


@app.post("/api/jobs/research", status_code=202)
def research(request: ResearchRequest):
    params = request.model_dump()
    symbol = _validate(resolve_symbol, request.symbol)
    kind = kind_for(symbol, request.kind)
    params.update(symbol=symbol, kind=kind, date=_validate(parse_analysis_date, request.date),
                  question=request.question.strip(), analysts=_validate(validate_analysts, request.analysts, symbol, kind))
    _require_providers()
    return JOBS.create("research", params)


@app.post("/api/jobs/backtest", status_code=202)
def backtest(request: BacktestRequest):
    symbols = list(dict.fromkeys(_validate(resolve_symbol, symbol) for symbol in request.symbols))
    if any(symbol.startswith("AMFI-") for symbol in symbols):
        raise HTTPException(400, "Mutual fund decision scoring needs a scheme benchmark and NAV settlement.")
    asset_types = {detect_asset_type(symbol).value for symbol in symbols}
    if len(asset_types) != 1:
        raise HTTPException(400, "Run separate backtests for crypto and exchange-listed instruments.")
    start = _validate(parse_analysis_date, request.start)
    end = _validate(parse_analysis_date, request.end)
    span = (calendar_date.fromisoformat(end) - calendar_date.fromisoformat(start)).days
    if span < 0:
        raise HTTPException(400, "The end date must be on or after the start date.")
    if len(symbols) * (span // request.every + 1) > 30:
        raise HTTPException(400, "This workspace supports up to 30 evaluations per backtest. Use a wider interval or fewer symbols.")
    dates = _validate(iter_grid, start, end, min(request.every, span + 1))
    filtered = request.analysts
    for symbol in symbols:
        filtered = _validate(validate_analysts, filtered, symbol, kind_for(symbol))
    _require_providers()
    return JOBS.create("backtest", {**request.model_dump(), "symbols": symbols, "dates": dates, "analysts": filtered})


def _require_providers():
    if missing := [value["provider"] for value in provider_status(CONFIG).values() if not value["ready"]]:
        raise HTTPException(503, f"Add the API key for {', '.join(dict.fromkeys(missing))} in .env and restart the dashboard.")


@app.get("/api/memory")
def memory():
    entries = TradingMemoryLog(CONFIG).load_entries()
    recent = sorted(entries, key=lambda item: item["date"], reverse=True)[:50]
    fields = ("date", "ticker", "rating", "pending", "raw", "alpha", "holding", "resolved", "reflection")
    return [{key: entry.get(key) for key in fields} for entry in recent]


@app.get("/api/library")
def library():
    reports = []
    for path in sorted(SAVED.glob("*/complete_report.md"), key=lambda item: item.parent.name.split("_")[-2:], reverse=True):
        identifier = path.parent.name
        match = REPORT_ID.fullmatch(identifier)
        if match:
            analysis_date = match["day"]
            try:
                with path.open(encoding="utf-8") as report:
                    for line in (report.readline() for _ in range(5)):
                        if found := re.fullmatch(r"- Analysis date: (\d{4}-\d{2}-\d{2})\s*", line):
                            analysis_date = found[1]
                            break
            except OSError:
                continue
            reports.append({"id": identifier, "symbol": match["symbol"], "date": analysis_date})
    return reports


def _report_file(directory: Path, extension: str):
    if extension == "summary":
        try:
            decision = (directory / "5_portfolio" / "decision.md").read_text(encoding="utf-8")
        except FileNotFoundError:
            return {"summary": ""}
        return {"summary": research_summary(decision)}
    if extension not in ("md", "html"):
        raise HTTPException(404, "Report format unavailable.")
    path = directory / f"complete_report.{extension}"
    if not path.is_file():
        raise HTTPException(404, "Report unavailable.")
    if extension == "html":
        return FileResponse(path, media_type="text/html", headers={
            "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        })
    return FileResponse(path, media_type="text/plain; charset=utf-8")


@app.get("/api/jobs/{identifier}/report/{extension}")
def report(identifier: str, extension: str):
    _read_job(identifier)
    return _report_file(JOBS.directory / identifier / "report", extension)


@app.get("/api/library/{identifier}/{extension}")
def saved_report(identifier: str, extension: str):
    if not REPORT_ID.fullmatch(identifier):
        raise HTTPException(404, "Report unavailable.")
    return _report_file(SAVED / identifier, extension)


if (DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")


@app.get("/chart-notice.txt")
def chart_notice():
    notice = DIST / "chart-notice.txt"
    if notice.is_file():
        return FileResponse(notice, media_type="text/plain")
    raise HTTPException(404, "Build the dashboard to view its attribution.")


@app.get("/")
def dashboard():
    if (DIST / "index.html").is_file():
        return FileResponse(DIST / "index.html")
    return JSONResponse({"detail": "Build the UI with npm --prefix web run build or start the Vite development server."}, status_code=503)


if __name__ == "__main__":
    import sys
    from logging.config import dictConfig

    import uvicorn

    dictConfig(uvicorn.config.LOGGING_CONFIG)
    configure_logging("market-desk", CONFIG["results_dir"])
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), access_log=False, log_config=None)
