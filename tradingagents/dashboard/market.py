"""Search and price history shared by the workspace and fund research."""

from __future__ import annotations

import math
import re
from datetime import date
from functools import lru_cache

import pandas as pd

from cli.prompts import detect_asset_type, parse_ticker
from tradingagents.dataflows.vendors.amfi import fund_directory, fund_nav
from tradingagents.dataflows.vendors.yahoo.ohlcv import load_ohlcv
from tradingagents.dataflows.vendors.yahoo.search import lookup_quotes
from tradingagents.memory.settlement import resolve_benchmark

KINDS = {"stock", "etf", "fund", "bond", "index", "crypto", "other"}


def instrument(symbol, name, kind, exchange):
    return {"symbol": symbol, "name": name, "kind": kind, "exchange": exchange}


DEFAULTS = [
    instrument("RELIANCE.NS", "Reliance Industries", "stock", "NSE"),
    instrument("TCS.NS", "Tata Consultancy Services", "stock", "NSE"),
    instrument("HDFCBANK.NS", "HDFC Bank", "stock", "NSE"),
    instrument("INFY.NS", "Infosys", "stock", "NSE"),
    instrument("NIFTYBEES.NS", "Nippon India ETF Nifty 50 BeES", "etf", "NSE"),
    instrument("^NSEI", "Nifty 50", "index", "NSE"),
    instrument("AMFI-122639", "Parag Parikh Flexi Cap Fund · Direct Growth", "fund", "AMFI"),
]

_KNOWN = {item["symbol"]: item for item in DEFAULTS}
_ALIASES = {symbol.split(".")[0]: symbol for symbol in _KNOWN if symbol.endswith(".NS")}
_ALIASES.update({"NIFTY": "^NSEI", "NIFTY50": "^NSEI", "SENSEX": "^BSESN"})


def resolve_symbol(value: str) -> str:
    raw = value.strip().upper()
    if re.fullmatch(r"\d{5,6}", raw):
        return f"AMFI-{raw}"
    if raw.startswith("BOND-"):
        if not re.fullmatch(r"BOND-IN[A-Z0-9]{10}", raw):
            raise ValueError("Enter a valid Indian bond ISIN after BOND-.")
        return raw
    if raw.startswith("AMFI-"):
        if not re.fullmatch(r"AMFI-\d{5,6}", raw):
            raise ValueError("Enter a five- or six-digit AMFI scheme code.")
        return raw
    return parse_ticker(_ALIASES.get(raw, raw))


def kind_for(symbol: str, preferred: str | None = None) -> str:
    if symbol.startswith("AMFI-"):
        return "fund"
    if symbol.startswith("BOND-"):
        return "bond"
    if detect_asset_type(symbol).value == "crypto":
        return "crypto"
    if symbol.startswith("^"):
        return "index"
    if symbol.endswith(("=F", "=X")):
        return "other"
    return _KNOWN.get(symbol, {}).get("kind") or preferred or "stock"


def exchange_for(symbol: str) -> str:
    if symbol.startswith("AMFI-"):
        return "AMFI"
    if symbol.startswith("BOND-"):
        return "NSE"
    if symbol.endswith(".NS") or symbol in {"^NSEI", "^NSEBANK"}:
        return "NSE"
    if symbol.endswith(".BO") or symbol == "^BSESN":
        return "BSE"
    return "Yahoo Finance"


def search_funds(query: str, day: str) -> list[dict]:
    terms = query.casefold().split()
    return [
        instrument(f"AMFI-{item['code']}", item["name"], "fund", "AMFI")
        for item in fund_directory(day)
        if all(term in f"AMFI-{item['code']} {item['name']}".casefold() for term in terms)
    ][:12]


def search_yahoo(query: str) -> list[dict]:
    return list(_search_yahoo(query, date.today().isoformat()))


@lru_cache(maxsize=128)
def _search_yahoo(query: str, day: str) -> tuple[dict, ...]:
    results = lookup_quotes(query)
    quote_kinds = {"EQUITY": "stock", "ETF": "etf", "MUTUALFUND": "fund", "INDEX": "index", "CRYPTOCURRENCY": "crypto", "FUTURE": "other", "CURRENCY": "other"}
    items = []
    for result in results:
        symbol = result.get("symbol")
        kind = quote_kinds.get(result.get("quoteType"))
        if not symbol or not kind:
            continue
        try:
            symbol = resolve_symbol(symbol)
        except ValueError:
            continue
        name = result.get("longname") or result.get("shortname") or symbol
        exchange = exchange_for(symbol)
        if exchange == "Yahoo Finance":
            exchange = result.get("exchDisp") or exchange
        items.append(instrument(symbol, name, kind, exchange))
    items.sort(key=lambda item: item["exchange"] not in ("NSE", "BSE"))
    return tuple(items)


def _number(value):
    value = float(value)
    return value if math.isfinite(value) else None


def _performance(bars: list[dict]) -> dict[str, float | None]:
    series = pd.Series({pd.Timestamp(bar["time"]): bar["close"] for bar in bars}, dtype=float).sort_index()
    last = series.iloc[-1]
    result = {}
    for label, months in (("1M", 1), ("3M", 3), ("6M", 6), ("1Y", 12)):
        cutoff = series.index[-1] - pd.DateOffset(months=months)
        base = series.asof(cutoff)
        result[label] = _number((last / base - 1) * 100) if pd.notna(base) and base else None
    year = series.loc[series.index[-1] - pd.DateOffset(years=1):]
    result["drawdown"] = _number((year / year.cummax().replace(0, float("nan")) - 1).min() * 100)
    return result


def chart_data(symbol: str, day: str, config: dict, preferred: str | None = None) -> dict:
    kind = kind_for(symbol, preferred)
    exchange = exchange_for(symbol)
    currency = "INR" if exchange in ("NSE", "BSE", "AMFI") else "USD" if kind == "crypto" else None
    name = _KNOWN.get(symbol, {}).get("name", symbol)
    metadata = {}
    benchmark = None
    if symbol.startswith("AMFI-"):
        fund, nav = fund_nav(symbol, day)
        start = (pd.Timestamp(day) - pd.DateOffset(years=5)).date().isoformat()
        bars = [bar for bar in nav if bar["time"] >= start] or list(nav[-1:])
        name = fund.get("scheme_name") or name
        metadata = {key: fund[key] for key in ("fund_house", "scheme_type", "scheme_category", "isin_growth") if fund.get(key)}
        source = "MFapi · AMFI NAV"
        pricing = "Published NAV"
    else:
        frame = load_ohlcv(symbol, day, fill_gaps=False)
        bars = []
        for _, row in frame.sort_values("Date").drop_duplicates("Date", keep="last").iterrows():
            bar = {"time": row["Date"].date().isoformat()}
            for key in ("Open", "High", "Low", "Close", "Volume"):
                if key in row and pd.notna(row[key]):
                    bar[key.lower()] = _number(row[key])
            if bar.get("close") is not None:
                bars.append(bar)
        source = "Yahoo Finance"
        pricing = "Adjusted daily prices"
        if kind in ("stock", "etf"):
            benchmark = resolve_benchmark(symbol, config)
            if benchmark == symbol:
                benchmark = None
    if not bars:
        raise ValueError(f"No price history was available for {symbol} through {day}.")
    latest = bars[-1]
    previous = bars[-2]["close"] if len(bars) >= 2 else None
    change = (latest["close"] - previous) if previous is not None else None
    coverage = (date.fromisoformat(latest["time"]) - date.fromisoformat(bars[0]["time"])).days
    return {
        **instrument(symbol, name, kind, exchange), "source": source, "pricing": pricing,
        "currency": currency, "benchmark": benchmark, "bars": bars, "last": latest, "as_of": day,
        "change": change, "change_pct": (change / previous * 100) if previous else None,
        "performance": _performance(bars), "metadata": metadata, "coverage_days": coverage,
    }
