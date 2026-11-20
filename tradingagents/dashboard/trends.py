"""Observed price, flow, and disclosure signals for the market trends view."""

from __future__ import annotations

import logging
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from functools import lru_cache
from time import time
from urllib.parse import urlsplit

from tradingagents.dataflows.vendors import nse
from tradingagents.dataflows.vendors.amfi import fund_directory, latest_previous_navs
from tradingagents.diagnostics import event, exception_fields, submit_traced

from .market import instrument
from .screener import _day, _num, latest_snapshot

AMFI_FLOWS = "https://www.amfiindia.com/research-information/amfi-monthly"
NSE_FLOWS = "https://www.nseindia.com/reports/fii-dii"
NSE_FILINGS = "https://www.nseindia.com/companies-listing/corporate-filings-announcements"
NSE_VIX = "https://www.nseindia.com/static/products-services/indices-indiavix-index"
NSE_ETFS = "https://www.nseindia.com/market-data/exchange-traded-funds-etf"
logger = logging.getLogger(__name__)


def _indices(payload):
    values = payload.get("data", ())
    selected = {"NIFTY 50", "NIFTY BANK", "NIFTY TOTAL MARKET", "INDIA VIX"}

    def view(item):
        return {
            "name": item.get("index"), "value": _num(item.get("last")), "change": _num(item.get("percentChange")),
            "advances": _num(item.get("advances")), "declines": _num(item.get("declines")),
            "unchanged": _num(item.get("unchanged")),
        }

    return {
        "timestamp": payload.get("timestamp", ""),
        "benchmarks": [view(item) for item in values if item.get("index") in selected],
        "sectors": sorted((view(item) for item in values if item.get("key") == "SECTORAL INDICES"),
                          key=lambda item: item["change"] or 0, reverse=True),
    }


def _listing_signals(rows):
    displayed = []
    for item in rows:
        metrics = item["metrics"]
        if metrics.get("change") is not None and metrics.get("turnover", 0) > 0:
            displayed.append({
                **{key: item[key] for key in ("symbol", "name", "kind", "exchange")},
                "price": metrics.get("price"), "change": metrics["change"], "turnover": metrics["turnover"],
                "observed": item.get("observed"),
            })
    active = sorted(displayed, key=lambda item: item["turnover"], reverse=True)
    above = sorted((item for item in displayed if item["change"] > 0), key=lambda item: item["change"], reverse=True)
    below = sorted((item for item in displayed if item["change"] < 0), key=lambda item: item["change"])
    return {"active": active[:12], "gainers": above[:12], "losers": below[:12]}


@lru_cache(maxsize=3)
def fund_movers(day: str, interval: int):
    recent = (date.fromisoformat(day) - timedelta(days=10)).isoformat()
    funds = [item for item in fund_directory(day, interval) if item.get("nav") and recent <= item["date"] <= day
             and "direct" in item["plan"].casefold() and "growth" in item["option"].casefold()]
    stamps = Counter(item["date"] for item in funds)
    threshold = max(stamps.values(), default=0) / 2
    session = max((stamp for stamp, count in stamps.items() if count >= threshold), default="")
    if not session:
        return {"rows": [], "session": "", "matched": 0}
    prior = latest_previous_navs((date.fromisoformat(session) - timedelta(days=1)).isoformat())
    records = []
    for item in funds:
        if item["date"] != session or item["code"] not in prior:
            continue
        name = item["name"]
        prev_day, prev_nav = prior[item["code"]]
        change = (item["nav"] / prev_nav - 1) * 100
        records.append({
            **instrument(f"AMFI-{item['code']}", name, "fund", "AMFI"),
            "price": item["nav"], "change": change, "category": item.get("category"),
            "observed": session, "previous": prev_day,
        })
    records.sort(key=lambda entry: abs(entry["change"]), reverse=True)
    return {"rows": records[:12], "session": session, "matched": len(records)}


def _filings(payload):
    latest = sorted(payload, key=lambda item: item.get("sort_date") or "", reverse=True)
    result = []
    for item in latest[:18]:
        title = item.get("attchmntText") or item.get("desc")
        if not title or not item.get("symbol"):
            continue
        target = item.get("attchmntFile") or ""
        if urlsplit(target).scheme != "https":
            target = NSE_FILINGS
        result.append({
            "symbol": item["symbol"] + ".NS", "name": item.get("sm_name") or item["symbol"],
            "title": title, "timestamp": item.get("an_dt"), "link": target,
        })
    return result


@lru_cache(maxsize=8)
def market_trends(day: str, bucket: int):
    with ThreadPoolExecutor(max_workers=6) as pool:
        sources = {
            "Market breadth": submit_traced(pool, nse.market_indices, bucket),
            "NSE stocks": submit_traced(pool, latest_snapshot, day, "stock"),
            "NSE ETFs": submit_traced(pool, latest_snapshot, day, "etf"),
            "Institutional flows": submit_traced(pool, nse.institutional_flows, bucket),
            "NSE filings": submit_traced(pool, nse.equity_filings, bucket),
        }
        data, unavailable = {}, []
        for name, future in sources.items():
            try:
                data[name] = future.result()
            except (OSError, ValueError, KeyError) as exc:
                unavailable.append(f"{name} ({type(exc).__name__})")
                event(logger, "market_trends.source_failed", "Market trends data was unavailable",
                      level=logging.WARNING, source=name, date=day, **exception_fields(exc))
    labels = ("NSE stocks", "NSE ETFs")
    for label in labels:
        if label in data and not data[label]["session"]:
            unavailable.append(f"{label} final prices")
    return {
        **_indices(data.get("Market breadth", {})),
        "stocks": _listing_signals(data.get("NSE stocks", {}).get("rows", ())),
        "etfs": _listing_signals(data.get("NSE ETFs", {}).get("rows", ())),
        "session": data.get("NSE stocks", {}).get("session", ""),
        "flows": [
            {"name": row.get("category"), "date": _day(row.get("date")), "net_crore": _num(row.get("netValue"))}
            for row in data.get("Institutional flows", ())
        ],
        "filings": _filings(data.get("NSE filings", [])), "unavailable": unavailable,
        "links": {"indices": nse.INDICES, "bhavcopy": nse.BHAVCOPY, "etfs": NSE_ETFS, "vix": NSE_VIX,
                  "institutional": NSE_FLOWS, "funds": AMFI_FLOWS, "filings": NSE_FILINGS},
    }


def trends_view(day: str):
    return market_trends(day, int(time() // 900))
