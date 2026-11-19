"""Persisted research jobs and progress for the local browser workspace."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections import Counter
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from queue import Queue
from threading import Thread
from typing import Literal
from uuid import uuid4

from langchain_core.messages import ToolMessage
from pydantic import BaseModel, Field

from cli.prompts import detect_asset_type, parse_analysts
from tradingagents.agents.rating import run_rating
from tradingagents.backtest import run_backtest, summarize
from tradingagents.dataflows.config import run_config
from tradingagents.dataflows.files import replace_file
from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.llm_clients.api_key_env import get_api_key_env
from tradingagents.llm_clients.factory import tier_provider
from tradingagents.portfolio import PortfolioContext

from .market import chart_data, kind_for
from .model_log import MODEL_LOG, ModelLog

logger = logging.getLogger(__name__)

ANALYSTS = ("market", "news", "fundamentals", "social")
MARKET_ONLY = {"index", "etf", "fund", "other"}
REPORT_STAGES = {
    "market": ("Market Analyst", "market_report"),
    "news": ("News Analyst", "news_report"),
    "fundamentals": ("Fundamentals Analyst", "fundamentals_report"),
    "social": ("Sentiment Analyst", "sentiment_report"),
    "research": ("Bull / Bear Research", "investment_plan"),
    "trader": ("Trader", "trader_investment_plan"),
    "risk": ("Risk Debate", "final_trade_decision"),
    "portfolio": ("Portfolio Manager", "final_trade_decision"),
}

Kind = Literal["stock", "etf", "fund", "index", "crypto", "other"]
Analyst = Literal["market", "news", "fundamentals", "social"]


class ResearchRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=40)
    kind: Kind | None = None
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    question: str = Field(default="", max_length=2500)
    analysts: list[Analyst] = Field(default_factory=lambda: list(ANALYSTS[:3]), min_length=1, max_length=4)
    rounds: int = Field(default=1, ge=1, le=3)
    language: str = Field(default="English", pattern=r"^[\w -]{2,40}$")
    checkpoint: bool = False
    portfolio: PortfolioContext | None = None


class BacktestRequest(BaseModel):
    symbols: list[str] = Field(min_length=1, max_length=8)
    start: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    end: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    every: int = Field(default=7, ge=1)
    analysts: list[Analyst] = Field(default_factory=lambda: ["market"], min_length=1, max_length=4)


def validate_analysts(keys: list[str], symbol: str, kind: str) -> list[str]:
    if symbol.startswith("AMFI-"):
        return ["market"]
    if kind in MARKET_ONLY or kind == "crypto":
        keys = [key for key in keys if key != "fundamentals"]
    return [item.value for item in parse_analysts(",".join(keys), detect_asset_type(symbol))]


def provider_status(config: dict) -> dict:
    tiers = {}
    for tier in ("quick", "deep"):
        provider = tier_provider(config, tier)
        key = get_api_key_env(provider)
        url = config.get(f"{tier}_think_backend_url") or config.get("backend_url") or ""
        label = "Sarvam" if provider == "openai_compatible" and url.rstrip("/") == "https://api.sarvam.ai/v2" else {
            "google": "Google Gemini", "openai": "OpenAI",
        }.get(provider, provider.replace("_", " ").title())
        required = provider not in ("chatgpt", "ollama", "bedrock", "openai_compatible") or label == "Sarvam"
        tiers[tier] = {
            "provider": label, "model": config.get(f"{tier}_think_llm") or "",
            "ready": bool(os.getenv(key)) if key and required else True,
        }
    return tiers


def _error_label(exc: Exception) -> str:
    status = getattr(exc, "status_code", None)
    if status in (401, 403):
        return "A model provider rejected its credentials or model access."
    if status in (402, 429):
        return "A model provider hit its quota, rate limit, or credit balance."
    return f"The run stopped with {type(exc).__name__}. Check the local server log for details."


class JobStore:
    """One worker keeps the trading memory and checkpoint writes serialized."""

    def __init__(self, config: dict):
        self.config = config
        self.directory = Path(config["results_dir"]) / "dashboard"
        self.queue = Queue()
        self.worker = None

    def start(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        for job in self.list_jobs():
            if job["status"] in ("queued", "running"):
                self.update(job, status="interrupted", error="The dashboard server restarted during this run.")
        self.worker = Thread(target=self._work, name="tradingagents-dashboard", daemon=True)
        self.worker.start()

    def read(self, identifier: str) -> dict:
        payload = json.loads((self.directory / identifier / "job.json").read_text(encoding="utf-8"))
        return payload

    def list_jobs(self) -> list[dict]:
        jobs = []
        for path in self.directory.glob("*/job.json"):
            try:
                jobs.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                logger.warning("Could not read dashboard job %s", path.parent.name)
        return sorted(jobs, key=lambda job: job["created"], reverse=True)

    def update(self, job: dict, **values):
        job.update(values)
        path = self.directory / job["id"] / "job.json"
        replace_file(path, lambda temp: Path(temp).write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8"))

    def create(self, kind: str, params: dict) -> dict:
        identifier = uuid4().hex
        job = {
            "id": identifier, "type": kind, "status": "queued", "params": params,
            "created": datetime.now(UTC).isoformat(), "providers": provider_status(self.config),
            "model_log": True,
        }
        (self.directory / identifier).mkdir(mode=0o700)
        self.update(job)
        self.queue.put(identifier)
        return job

    def _work(self):
        while True:
            identifier = self.queue.get()
            try:
                job = self.read(identifier)
                self.update(job, status="running")
                trace = ModelLog(self.directory / identifier / MODEL_LOG, job["providers"])
                try:
                    if job["type"] == "research":
                        self._research(job, trace)
                    else:
                        self._backtest(job, trace)
                    self.update(job, status="completed")
                except Exception as exc:
                    # Provider exceptions can embed credentials or request data.
                    logger.error("Dashboard job %s failed (%s, HTTP %s)", identifier,
                                 type(exc).__name__, getattr(exc, "status_code", None))
                    self.update(job, status="failed", error=_error_label(exc))
            finally:
                self.queue.task_done()

    def _research(self, job: dict, trace: ModelLog):
        params = job["params"]
        symbol, trade_date = params["symbol"], params["date"]
        kind = kind_for(symbol, params["kind"])
        is_amfi = symbol.startswith("AMFI-")
        asset_type = "fund" if is_amfi else detect_asset_type(symbol).value
        portfolio = PortfolioContext.model_validate(params["portfolio"]) if params["portfolio"] is not None else None
        config = {
            **self.config, "output_language": params["language"],
            "max_debate_rounds": params["rounds"], "max_risk_discuss_rounds": params["rounds"],
            "checkpoint_enabled": params["checkpoint"], "stream_model_output": True,
        }
        if is_amfi:
            config.update(data_vendors={"fund_nav": "MFapi (AMFI NAV)"}, tool_vendors={}, memory_log_path=None)
        if params["question"] or kind not in ("stock", "crypto"):
            # This distinguishes focused runs and asset-specific evidence in the existing
            # graph's checkpoint signature without serializing the question in metadata.
            config["dashboard_research_scope"] = hashlib.sha256(
                f"{kind}\n{params['question']}".encode()
            ).hexdigest()
        graph = TradingAgentsGraph(params["analysts"], config=config, callbacks=[trace])
        stages = [*params["analysts"], "research", "trader", "risk", "portfolio"]
        self.update(job, steps=[{"id": step, "name": REPORT_STAGES[step][0], "status": "pending"} for step in stages])
        args = graph.propagator.get_graph_args()

        with run_config(config), graph.checkpoint_scope(symbol, trade_date, asset_type, portfolio) as thread_id:
            if is_amfi:
                state = self._fund_state(graph, symbol, trade_date, portfolio, config)
            else:
                state = graph.create_run_state(symbol, trade_date, asset_type, portfolio)
                if kind in MARKET_ONLY:
                    state["instrument_context"] += (
                        f"\nAsset type: {kind}. Use only metrics applicable to this instrument. "
                        "For an ETF or fund, distinguish exchange price from NAV, and disclose if "
                        "holdings, expense ratio, benchmark, distributions or tracking error are unavailable."
                    )
            if params["question"]:
                state["instrument_context"] += (
                    "\nResearch focus from the user (within this instrument and date): "
                    + params["question"] + "\nAddress it using available evidence and state any gaps."
                )
            if thread_id:
                args["config"]["configurable"] = {"thread_id": thread_id}
            final = self._collect(job, graph, graph.checkpoint_input(state), args, trace)
        if not final.get("final_trade_decision"):
            raise RuntimeError("The agent graph ended without a final decision.")

        final["research_question"] = params["question"]
        graph.save_reports(final, symbol, self.directory / job["id"] / "report")
        if not is_amfi:
            graph.record_decision(symbol, trade_date, final)
        graph.clear_checkpoint_on_success(symbol, trade_date, asset_type, portfolio)
        self.update(job, rating=run_rating(final), report=True)

    @staticmethod
    def _fund_state(graph, symbol, trade_date, portfolio, config):
        chart = chart_data(symbol, trade_date, config, "fund")
        metrics = ", ".join(
            f"{label}: {value:+.2f}%" for label, value in chart["performance"].items() if value is not None
        )
        recent = ", ".join(f"{bar['time']}: INR {bar['close']:.4f}" for bar in chart["bars"][-8:])
        context = (
            f"Instrument: {chart['name']} ({symbol}), Indian mutual fund, currency INR. "
            f"Published daily NAV via MFapi, which mirrors AMFI. Through {trade_date}; latest available "
            f"{chart['last']['time']}. Recent NAV observations: {recent}. "
            f"Computed NAV-only changes and one-year max drawdown: {metrics or 'insufficient history'}. "
            "NAV is the value per unit. Exchange OHLC, volume, day-trading levels, underlying holdings, "
            "fees, tracking error and scheme benchmark figures were not sourced for this run. "
            "Discuss the scheme's trends and risks using only the NAV evidence; NAV changes are not "
            "total returns for distributing plans. Do not propose market, limit or stop orders for this fund."
        )
        return graph.propagator.create_initial_state(
            symbol, trade_date, asset_type="fund", instrument_context=context,
            portfolio_context=portfolio.render(symbol) if portfolio is not None else "",
        )

    def _collect(self, job, graph, graph_input, args, trace):
        final, seen_tools, tool_calls = {}, set(), Counter()
        for messages, state in graph.stream_run(graph_input, **args):
            updated = False
            for message in messages:
                if isinstance(message, ToolMessage) and message.name:
                    identifier = message.id or message.tool_call_id
                    if identifier in seen_tools:
                        continue
                    seen_tools.add(identifier)
                    tool_calls[message.name] += 1
                    trace.record_tool_result(message)
                    updated = True
            if state:
                final.update(state)
            steps = []
            analysis_done = all(final.get(REPORT_STAGES[step["id"]][1]) for step in job["steps"] if step["id"] in ANALYSTS)
            active = {
                "research": analysis_done,
                "trader": bool(final.get("investment_plan")),
                "risk": bool(final.get("trader_investment_plan")),
                "portfolio": (final.get("risk_debate_state") or {}).get("count", 0)
                >= 3 * job["params"]["rounds"],
            }
            for step in job["steps"]:
                key = step["id"]
                state_key = REPORT_STAGES[key][1]
                if final.get(state_key):
                    status = "complete"
                else:
                    status = "running" if key in ANALYSTS or active.get(key) else "pending"
                steps.append({**step, "status": status})
            if updated or steps != job["steps"]:
                self.update(job, steps=steps, tools=dict(tool_calls))
        return final

    def _backtest(self, job: dict, trace: ModelLog):
        p = job["params"]

        def progress(done, total, ticker, day):
            trace.select_cell(ticker, day)
            self.update(job, progress={"cell": done, "total": total, "symbol": ticker, "date": day})

        result = run_backtest(
            p["symbols"], p["dates"], {**self.config, "stream_model_output": True},
            selected_analysts=p["analysts"], callbacks=[trace],
            asset_type=detect_asset_type(p["symbols"][0]).value, progress=progress, run_id=job["id"],
        )
        self.update(job, summary=asdict(summarize(result)), cells_run=result.cells_run,
                    failed_cells=len(result.failures), settlement_failures=len(result.settlement_failures))
