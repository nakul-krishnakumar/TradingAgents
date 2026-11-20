"""India-first instrument screening over attributed, asset-specific metrics."""

from __future__ import annotations

import json
import logging
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime
from functools import lru_cache
from pathlib import Path
from time import time
from typing import Literal

import pandas as pd
from pydantic import BaseModel, ConfigDict, Field

from tradingagents.dataflows.config import run_config
from tradingagents.dataflows.files import replace_file
from tradingagents.dataflows.vendors import nsdl, nse
from tradingagents.dataflows.vendors.amfi import (
    AMFI_DIRECTORY,
    AMFI_TER,
    expense_ratios,
    fund_directory,
    latest_previous_navs,
    scheme_key,
)
from tradingagents.dataflows.vendors.yahoo.fundamentals import get_company_profile
from tradingagents.dataflows.vendors.yahoo.screening import net_income_matches
from tradingagents.diagnostics import event, exception_fields, submit_traced

from .market import DEFAULTS, chart_data, instrument
from .workspace_store import Asset

logger = logging.getLogger(__name__)
ScreenKind = Literal["all", "stock", "etf", "fund", "bond", "other"]
_EXCHANGE_KINDS = ("stock", "etf", "bond", "reit", "invit")
_PROFILE_URL = "https://finance.yahoo.com/quote/"
_OTHER = [
    instrument("^NSEI", "Nifty 50", "index", "NSE"),
    instrument("^BSESN", "Sensex", "index", "BSE"),
    instrument("^NSEBANK", "Nifty Bank", "index", "NSE"),
    instrument("GOLDBEES.NS", "Nippon India ETF Gold BeES", "etf", "NSE"),
    instrument("BTC-USD", "Bitcoin", "crypto", "Global"),
    instrument("ETH-USD", "Ethereum", "crypto", "Global"),
    instrument("USDINR=X", "USD / INR", "other", "Global"),
    instrument("GC=F", "Gold futures", "other", "Global"),
    instrument("CL=F", "WTI crude oil futures", "other", "Global"),
]

# Each key has one meaning and one unit across all instruments that use it.
AXES = [
    ("price", "Price / NAV", "₹", "Market", "stock etf fund bond other"),
    ("change", "Session change", "%", "Market", "stock etf bond other"),
    ("open", "Open", "₹", "Market", "stock etf other"),
    ("high", "High", "₹", "Market", "stock etf other"),
    ("low", "Low", "₹", "Market", "stock etf other"),
    ("volume", "Volume", "", "Liquidity", "stock etf bond other"),
    ("turnover", "Turnover", "₹", "Liquidity", "stock etf bond other"),
    ("trades", "Trades", "", "Liquidity", "stock etf bond other"),
    ("delivery_quantity", "Deliverable quantity", "", "Liquidity", "stock etf"),
    ("delivery_percent", "Deliverable share of volume", "%", "Liquidity", "stock etf"),
    ("relative_volume", "Volume vs previous session", "×", "Liquidity", "stock etf bond other"),
    ("week_high", "52-week high", "₹", "Market", "stock etf other"),
    ("week_low", "52-week low", "₹", "Market", "stock etf other"),
    ("from_high", "From 52-week high", "%", "Market", "stock etf other"),
    ("lot", "Market lot", "", "Market", "stock etf bond other"),
    ("return_1w", "1-week change", "%", "Performance", "stock etf bond other"),
    ("return_1m", "1-month return", "%", "Performance", "stock etf fund bond other"),
    ("return_3m", "3-month return", "%", "Performance", "stock etf fund bond other"),
    ("return_6m", "6-month return", "%", "Performance", "stock etf fund other"),
    ("return_1y", "1-year return", "%", "Performance", "stock etf fund bond other"),
    ("return_3y", "3-year annualized return", "%", "Performance", "stock etf fund other"),
    ("return_5y", "5-year annualized return", "%", "Performance", "stock etf fund other"),
    ("drawdown", "1-year max drawdown", "%", "Risk & technicals", "stock etf fund other"),
    ("volatility", "1-year annualized volatility", "%", "Risk & technicals", "stock etf fund other"),
    ("sma_50", "50-session average", "₹", "Risk & technicals", "stock etf fund other"),
    ("sma_200", "200-session average", "₹", "Risk & technicals", "stock etf fund other"),
    ("rsi", "RSI (14 sessions)", "", "Risk & technicals", "stock etf fund other"),
    ("beta", "Beta", "", "Risk & technicals", "stock etf other"),
    ("market_cap", "Market capitalization", "₹", "Valuation", "stock other"),
    ("pe", "Trailing P/E", "×", "Valuation", "stock other"),
    ("adjusted_pe", "NSE adjusted P/E", "×", "Valuation", "stock other"),
    ("forward_pe", "Forward P/E", "×", "Valuation", "stock other"),
    ("pb", "Price to book", "×", "Valuation", "stock other"),
    ("ps", "Price to sales", "×", "Valuation", "stock other"),
    ("peg", "PEG ratio", "×", "Valuation", "stock other"),
    ("ev", "Enterprise value", "₹", "Valuation", "stock"),
    ("ev_ebitda", "EV / EBITDA", "×", "Valuation", "stock"),
    ("ev_revenue", "EV / revenue", "×", "Valuation", "stock"),
    ("eps", "EPS", "₹", "Profitability", "stock other"),
    ("forecast_eps", "Forward EPS", "₹", "Profitability", "stock other"),
    ("net_income", "Net income (TTM)", "₹", "Profitability", "stock other"),
    ("revenue", "Revenue (TTM)", "₹", "Profitability", "stock other"),
    ("revenue_growth", "Revenue growth", "%", "Profitability", "stock other"),
    ("earnings_growth", "Earnings growth", "%", "Profitability", "stock other"),
    ("gross_profit", "Gross profit", "₹", "Profitability", "stock"),
    ("ebitda", "EBITDA", "₹", "Profitability", "stock"),
    ("profit_margin", "Net margin", "%", "Profitability", "stock other"),
    ("op_margin", "Operating margin", "%", "Profitability", "stock"),
    ("gross_margin", "Gross margin", "%", "Profitability", "stock"),
    ("roe", "Return on equity", "%", "Profitability", "stock other"),
    ("roa", "Return on assets", "%", "Profitability", "stock other"),
    ("total_debt", "Total debt", "₹", "Balance sheet & cash flow", "stock other"),
    ("total_cash", "Total cash", "₹", "Balance sheet & cash flow", "stock other"),
    ("debt_equity", "Debt to equity", "%", "Balance sheet & cash flow", "stock other"),
    ("current_ratio", "Current ratio", "×", "Balance sheet & cash flow", "stock"),
    ("quick_ratio", "Quick ratio", "×", "Balance sheet & cash flow", "stock"),
    ("free_cash", "Free cash flow", "₹", "Balance sheet & cash flow", "stock other"),
    ("operating_cash", "Operating cash flow", "₹", "Balance sheet & cash flow", "stock"),
    ("dividend", "Dividend yield", "%", "Income & holdings", "stock etf other"),
    ("payout", "Payout ratio", "%", "Income & holdings", "stock other"),
    ("insiders", "Insider ownership", "%", "Income & holdings", "stock"),
    ("institutions", "Institutional ownership", "%", "Income & holdings", "stock"),
    ("expense", "Expense ratio", "%", "Fund structure", "etf fund"),
    ("assets", "Net assets (AUM)", "₹", "Fund structure", "etf fund"),
    ("nav", "Published NAV", "₹", "Fund structure", "etf fund"),
    ("premium", "Price premium to NAV", "%", "Fund structure", "etf"),
    ("coupon", "Stated coupon", "%", "Bond terms", "bond"),
    ("years_left", "Years to maturity", "", "Bond terms", "bond"),
    ("face_value", "Face value", "₹", "Bond terms", "bond"),
    ("paid_up", "Paid-up value", "₹", "Bond terms", "bond"),
    ("redemption", "Redemption amount", "₹", "Bond terms", "bond"),
    ("issue_price", "Issue price", "₹", "Bond terms", "bond"),
]
_FIELDS = {row[0]: row for row in AXES}

_PROFILE_FIELDS = {
    "marketCap": "market_cap", "trailingPE": "pe", "forwardPE": "forward_pe", "priceToBook": "pb",
    "priceToSalesTrailing12Months": "ps", "trailingPegRatio": "peg", "enterpriseValue": "ev",
    "enterpriseToEbitda": "ev_ebitda", "enterpriseToRevenue": "ev_revenue",
    "trailingEps": "eps", "forwardEps": "forecast_eps", "netIncomeToCommon": "net_income",
    "totalRevenue": "revenue", "revenueGrowth": "revenue_growth", "earningsGrowth": "earnings_growth",
    "grossProfits": "gross_profit", "ebitda": "ebitda", "profitMargins": "profit_margin",
    "operatingMargins": "op_margin", "grossMargins": "gross_margin", "returnOnEquity": "roe",
    "returnOnAssets": "roa", "totalDebt": "total_debt", "totalCash": "total_cash",
    "debtToEquity": "debt_equity", "currentRatio": "current_ratio", "quickRatio": "quick_ratio",
    "freeCashflow": "free_cash", "operatingCashflow": "operating_cash", "dividendYield": "dividend",
    "payoutRatio": "payout", "heldPercentInsiders": "insiders", "heldPercentInstitutions": "institutions",
    "beta": "beta", "fiftyTwoWeekHigh": "week_high", "fiftyTwoWeekLow": "week_low",
    "totalAssets": "assets", "annualReportExpenseRatio": "expense",
}
_FRACTIONS = {
    "revenue_growth", "earnings_growth", "profit_margin", "op_margin", "gross_margin",
    "roe", "roa", "payout", "insiders", "institutions", "expense",
}
_CURRENCY_FIELDS = {key for key, _label, unit, *_ in AXES if unit == "₹"}
_CORPORATE_CURRENCY = {"net_income", "revenue", "gross_profit", "ebitda", "total_debt", "total_cash", "free_cash", "operating_cash"}
_PERIODS = {"return_1m": 1, "return_3m": 3, "return_6m": 6, "return_1y": 12, "return_3y": 36, "return_5y": 60}


class Bounds(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    key: str = Field(max_length=40)
    minimum: float | None = None
    maximum: float | None = None


class ScreenRequest(BaseModel):
    kind: ScreenKind = "stock"
    query: str = Field(default="", max_length=120)
    sector: str = Field(default="", max_length=180)
    category: str = Field(default="", max_length=180)
    exchange: str = Field(default="", max_length=40)
    plan: str = Field(default="", max_length=40)
    option: str = Field(default="", max_length=80)
    issuer: str = Field(default="", max_length=180)
    rating: str = Field(default="", max_length=15)
    frequency: str = Field(default="", max_length=180)
    filters: list[Bounds] = Field(default_factory=list, max_length=len(AXES))
    sort: str = Field(default="turnover", max_length=40)
    descending: bool = True
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=25, ge=1, le=100)


class EnrichRequest(BaseModel):
    assets: list[Asset] = Field(min_length=1, max_length=15)


def describe_axes() -> list[dict]:
    return [{"key": key, "label": label, "unit": unit, "group": group, "kinds": kinds.split()}
            for key, label, unit, group, kinds in AXES]


def _num(raw):
    if raw in ("", None):
        return None
    try:
        value = float(raw.strip().removesuffix("%").replace(",", "") if isinstance(raw, str) else raw)
        return value if math.isfinite(value) else None
    except (ValueError, TypeError):
        return None


def _day(raw):
    if not raw:
        return ""
    for pattern in ("%Y-%m-%d", "%d-%b-%Y", "%d-%b-%y", "%d-%m-%Y"):
        try:
            return datetime.strptime(raw, pattern).date().isoformat()
        except ValueError:
            continue
    return ""


def _entry(asset, source, link, **metadata):
    return {**asset, "source": source, "link": link, "metrics": {}, **metadata}


def _nse_assets(group, day, records):
    for data in records:
        raw_symbol = data.get("Symbol") or data.get("SYMBOL")
        if not raw_symbol:
            continue
        isin = data.get("ISINNumber") or data.get("ISIN NUMBER") or ""
        name = data.get("SecurityName") or data.get("NAME OF COMPANY") or raw_symbol
        issuer = name if group == "bond" else ""
        if group == "bond":
            if not isin.startswith("IN") or len(isin) != 12 or not isin.isalnum():
                continue
            symbol = f"BOND-{isin}"
            maturity = _day(data.get("REDEMPTION DATE"))
            if maturity and maturity < day:
                continue
            category = "Government securities" if isin.startswith("IN0") else "Listed debt"
            kind = "bond"
        else:
            symbol = raw_symbol + ".NS"
            category = data.get("ETF Underlying") or {"reit": "REIT", "invit": "InvIT"}.get(group, "")
            kind = group if group in ("stock", "etf") else "other"
            maturity = ""
        row = _entry(instrument(symbol, name, kind, "NSE"), "NSE security master", nse.TRADE_LISTINGS,
                     isin=isin, category=category, issuer=issuer, maturity=maturity,
                     series=data.get("SERIES") or "EQ", underlying=data.get("Underlying Key") or "",
                     listed=_day(data.get("DateofListing") or data.get("DATE OF LISTING")))
        row["metrics"] = {
            key: value for key, raw in (
                ("lot", data.get("MarketLot") or data.get("MARKET LOT") or data.get("MKT LOT")),
                ("face_value", data.get("FACE VALUE")), ("paid_up", data.get("PAID UP VALUE")),
                ("redemption", data.get("REDEMPTION AMT")), ("coupon", data.get("IP RATE")),
            ) if (value := _num(raw)) is not None
        }
        if maturity:
            row["metrics"]["years_left"] = (date.fromisoformat(maturity) - date.fromisoformat(day)).days / 365.25
        yield row


def _amfi_assets(funds):
    for fund in funds:
        code, name = fund["code"], fund["name"]
        price = {"price": fund["nav"], "nav": fund["nav"]} if fund.get("nav") is not None else {}
        yield _entry(
            instrument(f"AMFI-{code}", name, "fund", "AMFI"), "AMFI scheme directory", AMFI_DIRECTORY,
            isin=fund.get("isin", ""), issuer=fund.get("fund_house", ""), category=fund.get("category", ""),
            scheme_name=fund.get("scheme_name", ""),
            plan=fund.get("plan", ""), option=fund.get("option", ""), observed=fund.get("date", ""), metrics=price,
        )


def _raw_quotes(records):
    return {(row["ISIN"], row["SctySrs"]): row for row in records if row.get("ISIN") and row.get("SctySrs")}


def _change(new, previous):
    return (new / previous - 1) * 100 if new is not None and previous and previous > 0 else None


def _apply_quotes(rows, samples):
    if "close" not in samples:
        return ""
    session, current = samples["close"]
    quotes = _raw_quotes(current)
    historical = {key: _raw_quotes(records) for key, (observed, records) in samples.items()
                  if key != "close" and observed < session}
    for row in rows:
        identity = (row.get("isin"), row.get("series"))
        quote = quotes.get(identity)
        if quote is None or row["exchange"] != "NSE":
            continue
        price = _num(quote.get("ClsPric"))
        values = {
            "price": price, "change": _change(price, _num(quote.get("PrvsClsgPric"))),
            "open": _num(quote.get("OpnPric")), "high": _num(quote.get("HghPric")), "low": _num(quote.get("LwPric")),
            "volume": _num(quote.get("TtlTradgVol")), "turnover": _num(quote.get("TtlTrfVal")),
            "trades": _num(quote.get("TtlNbOfTxsExctd")),
        }
        for key, lookup in historical.items():
            prev = lookup.get(identity, {})
            if key == "previous":
                previous_volume = _num(prev.get("TtlTradgVol"))
                if previous_volume and values["volume"] is not None:
                    values["relative_volume"] = values["volume"] / previous_volume
            else:
                values[key] = _change(price, _num(prev.get("ClsPric")))
        row["metrics"].update({key: value for key, value in values.items() if value is not None})
        row["observed"] = session
        row["price_source"] = "NSE final cash-market bhavcopy"
    return session


def _apply_etf_stats(rows, payload):
    by_symbol = {item.get("symbol"): item for item in payload.get("data", ())}
    for row in rows:
        if row["kind"] != "etf":
            continue
        info = by_symbol.get(row["symbol"].removesuffix(".NS"))
        if info is None:
            continue
        metrics = row["metrics"]
        for key, field in (("week_high", "wkhi"), ("week_low", "wklo"), ("nav", "nav")):
            if (value := _num(info.get(field))) is not None:
                metrics[key] = value
        nav_date = _day(info.get("navDate") or info.get("navdate"))
        row["nav_date"] = nav_date
        # Match value dates before computing a premium; published NAV can lag.
        if nav_date and nav_date == row.get("observed"):
            premium = _change(metrics.get("price"), metrics.get("nav"))
            if premium is not None:
                metrics["premium"] = premium


def _apply_exchange_reports(rows, reports):
    lookup = {
        report: {(item.get("SYMBOL"), item.get("SERIES") if report != "valuation" else None): item
                 for item in records}
        for report, records in reports.items()
    }
    fields = {
        "valuation": {"pe": "SYMBOL P/E", "adjusted_pe": "ADJUSTED P/E"},
        "delivery": {"delivery_quantity": "DELIV_QTY", "delivery_percent": "DELIV_PER"},
        "range": {"week_high": "Adjusted_52_Week_High", "week_low": "Adjusted_52_Week_Low"},
    }
    for row in rows:
        if row["exchange"] != "NSE" or row["kind"] == "bond":
            continue
        symbol = row["symbol"].removesuffix(".NS")
        for report, table in lookup.items():
            entry = table.get((symbol, row.get("series") if report != "valuation" else None), {})
            if report == "valuation" and row["kind"] == "etf":
                continue
            for key, field in fields[report].items():
                if (value := _num(entry.get(field))) is not None:
                    row["metrics"][key] = value


def _apply_fund_data(rows, session, history, ter):
    for row in rows:
        plan = row.get("plan", "").casefold()
        if plan not in {"direct plan", "regular plan"} or row["kind"] != "fund":
            continue
        rate = ter.get(scheme_key(row.get("scheme_name", "")), {}).get(plan)
        if rate:
            row["metrics"]["expense"] = rate[1]
            row["expense_date"] = rate[0]
            row["expense_link"] = AMFI_TER
        # Growth plans provide a comparable NAV change without cash distributions.
        if "growth" not in row.get("option", "").casefold() or not row.get("observed", ""):
            continue
        if not 0 <= (date.fromisoformat(session) - date.fromisoformat(row["observed"])).days <= 7:
            continue
        code = row["symbol"].removeprefix("AMFI-")
        for key, samples in history.items():
            prior = samples.get(code)
            if prior and (value := _change(row["metrics"].get("nav"), prior[1])) is not None:
                row["metrics"][key] = value if _PERIODS[key] < 12 else ((1 + value / 100) ** (12 / _PERIODS[key]) - 1) * 100


@lru_cache(maxsize=8)
def snapshot(day: str, bucket: int, scope: str) -> dict:
    """Load complete reference lists and a small set of final bar snapshots."""
    close = pd.Timestamp(day)
    dates = {"close": day, "previous": (close - pd.Timedelta(days=1)).date().isoformat(),
             "return_1w": (close - pd.Timedelta(days=7)).date().isoformat()}
    for label, period in (("return_1m", 1), ("return_3m", 3), ("return_6m", 6), ("return_1y", 12)):
        dates[label] = (close - pd.DateOffset(months=period)).date().isoformat()
    include_funds = scope in {"all", "fund"}
    groups = _EXCHANGE_KINDS if scope == "all" else ("reit", "invit") if scope == "other" else (scope,) if scope != "fund" else ()
    rows, unavailable = [], []
    with ThreadPoolExecutor(max_workers=10) as pool:
        pending = {group: submit_traced(pool, nse.securities, group, day) for group in groups}
        if "stock" in groups:
            pending["sectors"] = submit_traced(pool, nse.industries, day)
        if groups:
            pending["quotes"] = submit_traced(pool, nse.sample_bhavcopies, dates)
        if "etf" in groups:
            pending["ETF statistics"] = submit_traced(pool, nse.market_etfs, bucket)
        if "bond" in groups:
            pending["NSDL debt terms"] = submit_traced(pool, nsdl.debt_terms, day)
        if include_funds:
            pending["AMFI"] = submit_traced(pool, fund_directory, day, bucket)
        values = {}
        for source, future in pending.items():
            try:
                values[source] = future.result()
            except (OSError, ValueError, KeyError) as exc:
                unavailable.append(f"{source} ({type(exc).__name__})")
                event(logger, "screener.source_failed", "Screener reference data was unavailable",
                      level=logging.WARNING, source=source, date=day, **exception_fields(exc))

    for group in groups:
        rows.extend(_nse_assets(group, day, values.get(group, ())))
    for row in rows:
        if row["kind"] == "stock":
            row["sector"] = values.get("sectors", {}).get(row["symbol"].removesuffix(".NS"), "")
    rows.extend(_amfi_assets(values.get("AMFI", ())))
    existing = {row["symbol"] for row in rows}
    if scope in {"all", "other"}:
        rows.extend(_entry(item, "Workspace symbol catalogue", _PROFILE_URL + item["symbol"])
                    for item in _OTHER if item["symbol"] not in existing and item["kind"] != "etf")
    rows.extend(_entry(item, "Workspace symbol catalogue", _PROFILE_URL + item["symbol"])
                for item in DEFAULTS if item["symbol"] not in existing and item["kind"] in groups)
    session = _apply_quotes(rows, values.get("quotes", {}))
    if groups and not session:
        unavailable.append("NSE final prices")
    _apply_etf_stats(rows, values.get("ETF statistics", {}))
    fund_session = max((row.get("observed", "") for row in rows if row["kind"] == "fund"
                        and row.get("observed", "") <= day), default="")
    reports, historical_navs, ter = {}, {}, {}
    with ThreadPoolExecutor(max_workers=10) as pool:
        requests = {}
        if session and set(groups).intersection({"stock", "etf"}):
            requests.update({name: (reports, submit_traced(pool, nse.equity_report, name, session))
                             for name in ("valuation", "delivery", "range")})
        if fund_session:
            start = pd.Timestamp(fund_session)
            requests.update({key: (historical_navs, submit_traced(pool,
                latest_previous_navs, (start - pd.DateOffset(months=months)).date().isoformat(),
            )) for key, months in _PERIODS.items()})
            expense_request = submit_traced(pool, expense_ratios, day)
        for name, (destination, future) in requests.items():
            try:
                destination[name] = future.result()
            except (OSError, ValueError, KeyError) as exc:
                unavailable.append(f"{name} ({type(exc).__name__})")
                event(logger, "screener.source_failed", "Historical screener data was unavailable",
                      level=logging.WARNING, source=name, date=day, **exception_fields(exc))
        if fund_session:
            try:
                ter = expense_request.result()
            except (OSError, ValueError, KeyError, ImportError) as exc:
                unavailable.append(f"AMFI TER ({type(exc).__name__})")
                event(logger, "screener.source_failed", "Mutual fund expense data was unavailable",
                      level=logging.WARNING, source="AMFI TER", date=day, **exception_fields(exc))
    _apply_exchange_reports(rows, reports)
    if fund_session:
        _apply_fund_data(rows, fund_session, historical_navs, ter)
    if "bond" in groups:
        for row in rows:
            terms = values.get("NSDL debt terms", {}).get(row.get("isin"))
            if row["kind"] != "bond" or not terms:
                continue
            row.update(rating=terms["rating"], rating_report=terms["rating_report"],
                       rating_date=terms["rating_date"], frequency=terms["frequency"], terms_link=nsdl.DEBT_MASTER)
            if (price := _num(terms["issue_price"])) is not None and price > 0:
                row["metrics"]["issue_price"] = price
    return {"rows": rows, "session": session, "unavailable": unavailable}


def latest_snapshot(day: str, scope: str) -> dict:
    return snapshot(day, int(time() // 900), scope)


def _profile_directory(config: dict) -> Path:
    return Path(config["data_cache_dir"]) / "workspace-screener"


def _profiles(day, config):
    result = {}
    for path in _profile_directory(config).glob("*.json"):
        try:
            profile = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if profile.get("day") == day:
            result[profile["symbol"]] = profile
    return result


def _history_metrics(chart):
    result = {
        name: chart["performance"][period] for name, period in (
            ("return_1m", "1M"), ("return_3m", "3M"), ("return_6m", "6M"), ("return_1y", "1Y"),
            ("drawdown", "drawdown"),
        ) if chart["performance"].get(period) is not None
    }
    series = pd.Series({pd.Timestamp(item["time"]): item["close"] for item in chart["bars"]}, dtype=float)
    last = series.iloc[-1]
    for label, months in (("return_3y", 36), ("return_5y", 60)):
        base_index = series.index[-1] - pd.DateOffset(months=months)
        prior = series.asof(base_index)
        if pd.notna(prior) and prior > 0:
            result[label] = ((last / prior) ** (12 / months) - 1) * 100
    year = series.loc[series.index[-1] - pd.DateOffset(years=1):]
    if len(year) >= 20:
        result["volatility"] = year.pct_change().std() * math.sqrt(252) * 100
    for count in (50, 200):
        if len(series) >= count:
            result[f"sma_{count}"] = series.tail(count).mean()
    if len(series) > 14:
        diff = series.diff().dropna().tail(14)
        up, down = diff.clip(lower=0).mean(), -diff.clip(upper=0).mean()
        result["rsi"] = 100 * up / (up + down) if up or down else 50
    return result


def _enrich_one(asset, day, config):
    symbol, kind = asset["symbol"], asset["kind"]
    if kind == "bond":
        return None
    item = {"symbol": symbol, "day": day, "metrics": {}, "sources": []}
    if kind != "fund" or not symbol.startswith("AMFI-"):
        try:
            info = get_company_profile(symbol)
        except (OSError, ValueError, RuntimeError) as exc:
            info = {}
            event(logger, "screener.profile_failed", "Investment profile was unavailable",
                  level=logging.WARNING, symbol=symbol, **exception_fields(exc))
        if info:
            item.update(sector=info.get("sector"), industry=info.get("industry"),
                        issuer=info.get("fundFamily"), category=info.get("category"))
            item["sources"].append("Yahoo Finance profile")
            if isinstance(info.get("mostRecentQuarter"), (int, float)):
                stamp = datetime.fromtimestamp(info["mostRecentQuarter"], UTC).date().isoformat()
                if stamp <= day:
                    item["financial_period"] = stamp
            for source, axis in _PROFILE_FIELDS.items():
                if axis in _CURRENCY_FIELDS:
                    currency_field = "financialCurrency" if axis in _CORPORATE_CURRENCY else "currency"
                    if info.get(currency_field) != "INR":
                        continue
                if (value := _num(info.get(source))) is not None:
                    item["metrics"][axis] = value * 100 if axis in _FRACTIONS else value

    try:
        with run_config(config):
            chart = chart_data(symbol, day, config, kind)
        if chart["currency"] == "INR" or kind == "fund":
            item["metrics"].update(_history_metrics(chart))
            if chart["last"].get("close") is not None:
                item["history_price"] = chart["last"]["close"]
                item["history_date"] = chart["last"]["time"]
        else:
            item["metrics"].update({key: value for key, value in _history_metrics(chart).items()
                                    if key not in _CURRENCY_FIELDS})
        item["sources"].append(chart["source"] + " history")
    except (OSError, ValueError, RuntimeError) as exc:
        event(logger, "screener.history_failed", "Investment price history was unavailable",
              level=logging.WARNING, symbol=symbol, **exception_fields(exc))
    folder = _profile_directory(config)
    folder.mkdir(parents=True, exist_ok=True)
    replace_file(folder / f"{symbol}.json", lambda filename: Path(filename).write_text(
        json.dumps(item, allow_nan=False, ensure_ascii=False), encoding="utf-8",
    ))
    return item if item["sources"] else None


def enrich(request: EnrichRequest, day: str, config: dict):
    assets = {asset.symbol: asset.stored() for asset in request.assets}
    loaded, unavailable = [], []
    with ThreadPoolExecutor(max_workers=5) as pool:
        pending = {symbol: submit_traced(pool, _enrich_one, asset, day, config) for symbol, asset in assets.items()}
        for symbol, action in pending.items():
            try:
                result = action.result()
            except (OSError, ValueError, RuntimeError):
                result = None
            (loaded if result else unavailable).append(symbol)
    return {"loaded": loaded, "unavailable": unavailable}


def screen(request: ScreenRequest, day: str, config: dict) -> dict:
    if request.sort not in _FIELDS and request.sort != "name":
        raise ValueError("Unknown sort field.")
    for axis in request.filters:
        if axis.key not in _FIELDS:
            raise ValueError(f"Unknown screening field {axis.key}.")
        if axis.minimum is not None and axis.maximum is not None and axis.minimum > axis.maximum:
            raise ValueError("A minimum cannot exceed its maximum.")
    source = latest_snapshot(day, request.kind)
    profiles = _profiles(day, config)
    rows = []
    for base in source["rows"]:
        profile = profiles.get(base["symbol"], {})
        row = {**base, "metrics": {**base["metrics"], **profile.get("metrics", {})}}
        for key in ("pe", "week_high", "week_low", "expense"):
            if key in base["metrics"]:
                row["metrics"][key] = base["metrics"][key]
        for field in ("sector", "category", "issuer", "industry"):
            if profile.get(field) and not row.get(field):
                row[field] = profile[field]
        if profile:
            row["profile_sources"] = profile["sources"]
            if profile.get("financial_period"):
                row["financial_period"] = profile["financial_period"]
            if row["metrics"].get("price") is None and "history_price" in profile:
                row["metrics"]["price"] = profile["history_price"]
                row["observed"] = profile["history_date"]
                row["price_source"] = "Cached instrument history"
        if row["metrics"].get("week_high"):
            metric = _change(row["metrics"].get("price"), row["metrics"]["week_high"])
            if metric is not None:
                row["metrics"]["from_high"] = metric
        rows.append(row)

    facet_fields = ("sector", "category", "exchange", "issuer", "plan", "option", "rating", "frequency")
    options = {name: sorted({row[name] for row in rows if row.get(name)}) for name in facet_fields}
    tokens = request.query.casefold().split()
    searched = []
    for row in rows:
        text = " ".join(str(row.get(part, "")) for part in ("symbol", "name", "isin", "underlying", "issuer", "industry")).casefold()
        if not all(token in text for token in tokens):
            continue
        if any(getattr(request, field) and getattr(request, field) != row.get(field) for field in facet_fields):
            continue
        searched.append(row)

    unavailable = list(source["unavailable"])
    profit = next((axis for axis in request.filters if axis.key == "net_income"
                   and (axis.minimum is not None or axis.maximum is not None)), None)
    profit_ranks = {}
    if profit and request.kind in {"stock", "all"} and any(row["kind"] == "stock" for row in searched):
        try:
            profit_ranks = {symbol: index for index, symbol in enumerate(net_income_matches(day, profit.minimum, profit.maximum))}
        except (OSError, RuntimeError, ValueError, KeyError, TypeError):
            unavailable.append("Yahoo net income range")

    def accepts(row):
        for axis in request.filters:
            value = row["metrics"].get(axis.key)
            if value is None and axis is profit and row["kind"] == "stock" and row["symbol"] in profit_ranks:
                continue
            if value is None or (axis.minimum is not None and value < axis.minimum) or (axis.maximum is not None and value > axis.maximum):
                return False
        return True

    selected = [row for row in searched if accepts(row)]
    if request.sort == "name":
        selected.sort(key=lambda row: row["name"].casefold(), reverse=request.descending)
    else:
        field = request.sort
        known = sorted((row for row in selected if row["metrics"].get(field) is not None),
                       key=lambda row: row["metrics"][field], reverse=request.descending)
        missing = [row for row in selected if row["metrics"].get(field) is None]
        if field == "net_income" and profit_ranks:
            # The source orders matched symbols by net income before returning their tickers.
            missing.sort(key=lambda row: profit_ranks.get(row["symbol"], len(profit_ranks)), reverse=not request.descending)
        selected = known + missing

    added_profit = {row["symbol"] for row in selected if row["metrics"].get("net_income") is None
                    and row["symbol"] in profit_ranks}

    coverage = {axis: sum(row["metrics"].get(axis) is not None for row in searched) for axis in _FIELDS}
    pending = [row for row in searched if row["symbol"] not in profiles and row["kind"] != "bond"]
    pending.sort(key=lambda row: (row["symbol"] in added_profit, row["metrics"].get("turnover", 0)), reverse=True)
    return {
        "rows": [{**row, "profit_range_match": row["symbol"] in added_profit}
                 for row in selected[request.offset:request.offset + request.limit]], "total": len(selected),
        "enrichment_candidates": pending[:15], "enrichment_pending": len(pending),
        "scope_count": len(rows), "search_count": len(searched), "session": source["session"],
        "unavailable": unavailable, "options": options, "coverage": coverage, "profit_range_match_count": len(added_profit),
        "enriched": sum(bool(profiles.get(row["symbol"], {}).get("sources")) for row in searched), "axes": describe_axes(),
    }


def quick_search_bonds(query: str, day: str) -> list[dict]:
    terms = query.casefold().split()
    matches = []
    for row in _nse_assets("bond", day, nse.securities("bond", day)):
        description = f"{row['symbol']} {row['name']} {row['isin']}".casefold()
        if all(term in description for term in terms):
            matches.append({key: row[key] for key in ("symbol", "name", "kind", "exchange")})
            if len(matches) >= 12:
                break
    return matches
