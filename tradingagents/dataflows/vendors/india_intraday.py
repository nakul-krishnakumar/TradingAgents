"""Timestamped market inputs for the local NSE trading desk."""

from __future__ import annotations

import math
import os
import re
from datetime import date, datetime, time as wall_time, timedelta
from functools import lru_cache
from time import time
from urllib.parse import quote
from zoneinfo import ZoneInfo

import requests
import yfinance as yf

from tradingagents.dataflows.errors import VendorError
from tradingagents.dataflows.vendors.yahoo.common import yf_retry

IST = ZoneInfo("Asia/Kolkata")
_NSE = "https://www.nseindia.in"
_NSE_ALTERNATE = "https://www.nseindia.com"
_UPSTOX = "https://api.upstox.com"
_HEADERS = {"User-Agent": "TradingAgents local research", "Accept": "application/json"}
_ISIN = re.compile(r"IN[A-Z0-9]{10}")
_NSE_TICKER = re.compile(r"(?:[A-Z0-9&_-]{1,30}\.NS|\^NSEI|\^NSEBANK)")


def _get(url: str, *, params=None, token="", timeout=7):
    headers = {**_HEADERS, "Authorization": f"Bearer {token}"} if token else _HEADERS
    response = requests.get(url, headers=headers, params=params, timeout=timeout)
    response.raise_for_status()
    return response.json()


def _session(verified: bool, opens: int | None, closes: int | None, source: str, note: str) -> dict:
    return {"verified": verified, "opens": opens, "closes": closes, "source": source, "note": note}


@lru_cache(maxsize=8)
def _nse_holidays(interval: int) -> dict[date, str]:
    data = _get(f"{_NSE}/api/holiday-master", params={"type": "trading"})
    return {datetime.strptime(row["tradingDate"], "%d-%b-%Y").date(): row.get("description", "Exchange holiday")
            for row in data["CM"]}


@lru_cache(maxsize=96)
def _session_for(day: str, interval: int) -> dict:
    requested = date.fromisoformat(day)
    try:
        payload = _get(f"{_UPSTOX}/v2/market/timings/{day}")
        if payload.get("status") == "success" and isinstance(payload.get("data"), list):
            periods = []
            for entry in payload["data"]:
                if entry.get("exchange") != "NSE":
                    continue
                opening, closing = (int(entry[name]) // 1000 for name in ("start_time", "end_time"))
                if opening >= closing or datetime.fromtimestamp(opening, IST).date() != requested:
                    raise ValueError("Unexpected NSE session timestamps")
                periods.append((opening, closing))
            if not periods:
                return _session(True, None, None, "Upstox market calendar", "No NSE cash session scheduled.")
            if len(periods) == 1:
                opening, closing = periods[0]
                return _session(True, opening, closing, "Upstox market calendar", "NSE cash session.")
            return _session(False, None, None, "Upstox market calendar", "NSE has multiple session windows.")
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError):
        pass

    try:
        holidays = _nse_holidays(interval)
        if requested.year in {holiday.year for holiday in holidays}:
            holiday = holidays.get(requested)
            if holiday and any(word in holiday.casefold() for word in ("muhurat", "diwali laxmi", "diwali-laxmi")):
                return _session(False, None, None, "NSE trading calendar", "Special-session hours are unavailable.")
            if holiday or requested.weekday() >= 5:
                return _session(True, None, None, "NSE trading calendar", holiday or "No regular weekend session.")
            opening = int(datetime.combine(requested, wall_time(9, 15), IST).timestamp())
            closing = int(datetime.combine(requested, wall_time(15, 30), IST).timestamp())
            return _session(True, opening, closing, "NSE trading calendar", "Regular NSE cash session hours.")
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        pass
    return _session(False, None, None, "Market calendar unavailable", "Could not verify NSE cash session hours.")


def session_for(day: str) -> dict:
    """Resolve NSE cash session hours or a verified closure for an IST date."""
    return _session_for(day, int(time() // 900))


@lru_cache(maxsize=16)
def active_equities(bucket: int) -> dict:
    return _get(f"{_NSE}/api/live-analysis-most-active-securities", params={"index": "value"})


@lru_cache(maxsize=16)
def market_status(bucket: int) -> dict:
    try:
        return _get(f"{_NSE}/api/marketStatus")
    except (OSError, ValueError):
        return _get(f"{_NSE_ALTERNATE}/api/marketStatus")


@lru_cache(maxsize=16)
def preopen_equities(bucket: int) -> dict:
    return _get(f"{_NSE}/api/market-data-pre-open", params={"key": "NIFTY 50"})


@lru_cache(maxsize=8)
def corporate_actions(day: str, interval: int) -> list[dict]:
    target = date.fromisoformat(day)
    day_text = target.strftime("%d-%m-%Y")
    return _get(f"{_NSE}/api/corporates-corporateActions", params={
        "index": "equities", "from_date": day_text, "to_date": day_text,
    })


def _filing_time(row: dict) -> datetime | None:
    for field, pattern in (("exchdisstime", "%d-%b-%Y %H:%M:%S"),
                           ("sort_date", "%Y-%m-%d %H:%M:%S"),
                           ("an_dt", "%d-%b-%Y %H:%M:%S")):
        try:
            return datetime.strptime(row.get(field, ""), pattern)
        except (ValueError, TypeError):
            continue
    return None


@lru_cache(maxsize=12)
def _disclosures(day: str, interval: int) -> list[dict]:
    end = date.fromisoformat(day)
    start = end - timedelta(days=3)
    dates = {"from_date": f"{start:%d-%m-%Y}", "to_date": f"{end:%d-%m-%Y}"}
    for host, params in ((_NSE, dates), (_NSE_ALTERNATE, dates), (_NSE_ALTERNATE, {})):
        try:
            rows = _get(f"{host}/api/corporate-announcements", params={"index": "equities", **params})
            selected = [(stamp, row) for row in rows if isinstance(row, dict)
                        if (stamp := _filing_time(row)) and start <= stamp.date() <= end]
            if selected:
                return [row for _, row in sorted(selected, key=lambda item: item[0], reverse=True)]
        except (OSError, ValueError, TypeError):
            continue
    return []


def disclosures(day: str) -> list[dict]:
    """Get raw exchange filing records dated through the requested trading day."""
    return _disclosures(day, int(time() // 900))


def _clean_candles(records, first: date, last: date) -> list[dict]:
    output = {}
    for row in records:
        try:
            observed = datetime.fromisoformat(str(row[0]))
            prices = tuple(float(value) for value in row[1:6])
            opening, high, low, closing, volume = prices
        except (ValueError, TypeError, IndexError):
            continue
        if observed.tzinfo is None or not first <= observed.astimezone(IST).date() <= last:
            continue
        if not all(map(math.isfinite, prices)) or min(opening, high, low, closing) <= 0 or volume < 0:
            continue
        if high < max(opening, closing) or low > min(opening, closing):
            continue
        epoch = int(observed.timestamp())
        output[epoch] = {"time": epoch, "open": opening, "high": high, "low": low, "close": closing, "volume": volume}
    return [output[epoch] for epoch in sorted(output)]


def _yahoo_candles(symbol: str, start: date, end: date) -> list[dict]:
    ticker = symbol.strip().upper()
    if not _NSE_TICKER.fullmatch(ticker):
        raise ValueError("Choose an NSE listing for intraday candles.")

    def fetch():
        return yf.Ticker(ticker).history(start=start.isoformat(), end=(end + timedelta(days=1)).isoformat(),
                                        interval="5m", prepost=False, auto_adjust=False, actions=False, timeout=8)

    data = yf_retry(fetch, max_retries=1, base_delay=1)
    if data is None or data.empty:
        return []
    return _clean_candles(data[["Open", "High", "Low", "Close", "Volume"]].itertuples(), start, end)


@lru_cache(maxsize=192)
def history(symbol: str, day: str, period: str = "10d") -> list[dict]:
    """Fetch a day-cached Yahoo 5-minute lookback for prior-session calculations."""
    if not re.fullmatch(r"[1-9]\d?d", period) or int(period[:-1]) > 59:
        raise ValueError("Choose a Yahoo lookback from 1 to 59 days.")
    end = date.fromisoformat(day)
    start = end - timedelta(days=int(period[:-1]) - 1)
    return _yahoo_candles(symbol, start, end)


@lru_cache(maxsize=4)
def _upstox_authenticated(token: str, interval: int) -> bool:
    """Check the broker's authenticated status endpoint before labeling its feed."""
    try:
        return _get(f"{_UPSTOX}/v2/market/status/NSE", token=token).get("status") == "success"
    except (OSError, ValueError, AttributeError):
        return False


def _upstox_token():
    return (os.environ.get("UPSTOX_ANALYTICS_TOKEN") or os.environ.get("UPSTOX_ACCESS_TOKEN") or "").strip()


def live_quotes(assets, day):
    """Fetch a read-only, timestamped top of book for the watchlist."""
    token = _upstox_token()
    keys = {f"NSE_EQ|{asset['isin']}": asset["symbol"] for asset in assets
            if _ISIN.fullmatch(asset.get("isin") or "")}
    if not token or not keys or not _upstox_authenticated(token, int(time() // 600)):
        return {}
    response = _get(f"{_UPSTOX}/v3/market-quote/quotes", params={"instrument_key": ",".join(keys)}, token=token)
    quotes = {}
    for value in response.get("data", {}).values():
        symbol = keys.get(value.get("instrument_token"))
        if symbol is None:
            continue
        try:
            bids, asks = value["depth"]["buy"], value["depth"]["sell"]
            bid, ask, last = float(bids[0]["price"]), float(asks[0]["price"]), float(value["last_price"])
            offered = int(asks[0]["quantity"])
            stamp = datetime.fromisoformat(value["timestamp"])
            last_trade = int(value["last_trade_time"]) // 1000
            if stamp.tzinfo is None or not 0 < bid <= ask or last <= 0 or offered <= 0:
                continue
            if not all(math.isfinite(price) for price in (bid, ask, last)):
                continue
            quotes[symbol] = {"bid": bid, "ask": ask, "last": last, "ask_quantity": offered,
                              "at": int(stamp.timestamp()), "last_trade_at": last_trade}
        except (IndexError, KeyError, OSError, OverflowError, TypeError, ValueError):
            continue
    return quotes


def intraday(symbol: str, isin: str, day: str) -> tuple[list[dict], str, str]:
    """Fetch fresh same-day bars and identify the provider and credential status."""
    selected = date.fromisoformat(day)
    token = _upstox_token()
    if isinstance(isin, str) and _ISIN.fullmatch(isin):
        reference = quote(f"NSE_EQ|{isin}", safe="")
        try:
            response = _get(f"{_UPSTOX}/v3/historical-candle/intraday/{reference}/minutes/5", token=token)
            bars = _clean_candles(response["data"]["candles"], selected, selected)
            if bars:
                mode = "authenticated" if token and _upstox_authenticated(token, int(time() // 600)) else "reference"
                return bars, "Upstox", mode
        except (OSError, ValueError, KeyError, TypeError):
            pass
    try:
        return _yahoo_candles(symbol, selected, selected), "Yahoo Finance", "reference"
    except (VendorError, ValueError, KeyError):
        return [], "Yahoo Finance", "reference"
