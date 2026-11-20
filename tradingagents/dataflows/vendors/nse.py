"""NSE public security masters and final cash-market bhavcopy."""

from __future__ import annotations

import csv
import io
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from functools import lru_cache
from zipfile import BadZipFile, ZipFile

import requests

_ARCHIVES = "https://archives.nseindia.com"
_HEADERS = {"User-Agent": "TradingAgents local research", "Accept": "application/json, text/csv, */*"}
MASTERS = {
    "stock": "EQUITY_L.csv", "etf": "eq_etfseclist.csv", "bond": "DEBT.csv",
    "reit": "REITS_L.csv", "invit": "INVITS_L.csv", "sme": "SME_EQUITY_L.csv",
}
TRADE_LISTINGS = "https://www.nseindia.com/market-data/securities-available-for-trading"
BHAVCOPY = "https://www.nseindia.com/all-reports"
INDICES = "https://www.nseindia.com/market-data/live-equity-market"


def _get(url: str):
    response = requests.get(url, headers=_HEADERS, timeout=9)
    response.raise_for_status()
    return response


def _rows(text: str) -> tuple[dict, ...]:
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    return tuple({
        key.strip(): (value or "").strip() for key, value in row.items() if key is not None
    } for row in reader)


@lru_cache(maxsize=24)
def securities(group: str, day: str) -> tuple[dict, ...]:
    text = _get(f"{_ARCHIVES}/content/equities/{MASTERS[group]}").content.decode("utf-8-sig", errors="replace")
    header, _, records = text.partition("\n")
    if group == "bond" and "ISIN" not in header.upper():
        # The public debt file includes the ISIN after its last named column.
        text = header.rstrip("\r") + ",ISIN NUMBER\n" + records
    return _rows(text)


@lru_cache(maxsize=4)
def short_eligible_symbols(day: str) -> frozenset[str]:
    """Read the current NSE equity-derivatives list for this session's paper shorts."""
    response = _get("https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv")
    rows = iter(_rows(response.content.decode("utf-8-sig", errors="replace")))
    for row in rows:
        if row.get("UNDERLYING") == "Derivatives on Individual Securities":
            break
    symbols = set()
    for row in rows:
        nearest_lot = next((value for key, value in row.items() if key not in {"UNDERLYING", "SYMBOL"}), "")
        if row.get("SYMBOL") and nearest_lot.isdecimal() and int(nearest_lot) > 0:
            symbols.add(row["SYMBOL"])
    if not symbols:
        raise ValueError("NSE returned an empty equity-derivatives list.")
    return frozenset(symbols)


@lru_cache(maxsize=4)
def industries(day: str) -> dict[str, str]:
    url = "https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv"
    return {row["Symbol"]: row["Industry"] for row in _rows(_get(url).text)
            if row.get("Symbol") and row.get("Industry")}


@lru_cache(maxsize=48)
def _bhavcopy(day: str) -> tuple[dict, ...]:
    stamp = day.replace("-", "")
    filename = f"BhavCopy_NSE_CM_0_0_0_{stamp}_F_0000.csv"
    response = _get(f"{_ARCHIVES}/content/cm/{filename}.zip")
    with ZipFile(io.BytesIO(response.content)) as archive:
        return _rows(archive.read(filename).decode("utf-8-sig"))


def last_bhavcopy(as_of: str) -> tuple[str, tuple[dict, ...]]:
    """Find published final bars through this date, including holiday gaps."""
    end = date.fromisoformat(as_of)
    last_error = None
    # Search descending by calendar date, including special weekend sessions.
    for shift in range(8):
        day = (end - timedelta(days=shift)).isoformat()
        try:
            return day, _bhavcopy(day)
        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code in (404, 410):
                last_error = exc
                continue
            raise
    raise ValueError(f"No final NSE cash-market report found through {as_of}.") from last_error


@lru_cache(maxsize=8)
def market_indices(interval: int) -> dict:
    return _get("https://www.nseindia.com/api/allIndices").json()


@lru_cache(maxsize=8)
def market_etfs(interval: int) -> dict:
    return _get("https://www.nseindia.com/api/etf").json()


def sample_bhavcopies(as_of_dates: dict[str, str]) -> dict[str, tuple[str, tuple[dict, ...]]]:
    result = {}
    with ThreadPoolExecutor(max_workers=5) as pool:
        requests_by_period = {label: pool.submit(last_bhavcopy, day) for label, day in as_of_dates.items()}
        for label, pending in requests_by_period.items():
            try:
                result[label] = pending.result()
            except (OSError, ValueError, KeyError, BadZipFile):
                continue
    return result


@lru_cache(maxsize=12)
def equity_report(report: str, session: str) -> tuple[dict, ...]:
    day = date.fromisoformat(session)
    paths = {
        "valuation": f"/content/equities/peDetail/PE_{day:%d%m%y}.csv",
        "delivery": f"/products/content/sec_bhavdata_full_{day:%d%m%Y}.csv",
        "range": f"/content/CM_52_wk_High_low_{day:%d%m%Y}.csv",
    }
    content = _get(f"{_ARCHIVES}{paths[report]}").content.decode("utf-8-sig", errors="replace")
    if report == "range":
        lines = content.splitlines()
        content = "\n".join(lines[2:])
    return _rows(content)


@lru_cache(maxsize=8)
def institutional_flows(interval: int) -> list[dict]:
    return _get("https://www.nseindia.in/api/fiidiiTradeReact").json()


@lru_cache(maxsize=8)
def equity_filings(interval: int) -> list[dict]:
    return _get("https://www.nseindia.com/api/corporate-announcements?index=equities").json()
