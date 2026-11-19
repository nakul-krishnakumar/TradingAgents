"""Local scheduler and attributable data for the India daily trading desk."""

from __future__ import annotations

import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import datetime, time, timedelta
from pathlib import Path
from threading import Event, Lock, Thread
from time import monotonic
from urllib.parse import urlsplit

from pydantic import BaseModel, Field

from tradingagents.dataflows.errors import VendorError
from tradingagents.dataflows.files import replace_file
from tradingagents.dataflows.vendors import india_intraday as provider, nse

from .daily_paper import DailyPaper
from .daily_strategy import (
    BAR_SECONDS,
    CLOSE,
    ENTRY_CUTOFF,
    IST,
    LAST_CONTINUOUS_BAR,
    OPEN,
    Candle,
    evaluate,
    indicators,
    position_size,
)
from .market import DEFAULTS
from .screener import _num

logger = logging.getLogger(__name__)
READY_LAG_SECONDS = 60
PAPER_ACTIVE_NAMES = 20
PAPER_ROTATION = 12
SKILL = Path(__file__).parent / "skills" / "nse-daily-trading" / "SKILL.md"
SOURCES = [
    {"label": "NSE trading hours", "url": "https://www.nseindia.com/market-data/market-timings"},
    {"label": "NSE most active equities", "url": "https://www.nseindia.com/market-data/most-active-equities"},
    {"label": "NSE company disclosures", "url": "https://www.nseindia.com/companies-listing/corporate-filings-announcements"},
    {"label": "Zerodha charges", "url": "https://zerodha.com/charges"},
    {"label": "Upstox quote fields", "url": "https://upstox.com/developer/api-documentation/get-full-market-quote-v3/"},
    {"label": "SEBI study on intraday cash trading", "url": "https://www.sebi.gov.in/reports-and-statistics/research/jul-2024/study-analysis-of-intraday-trading-by-individuals-in-equity-cash-segment_84946.html"},
]
_EMPTY = {
    "verified": False, "opens": None, "closes": None, "note": "The NSE cash session calendar is being verified.",
}


class DailyBudget(BaseModel):
    budget: float = Field(ge=0, le=1_000_000_000, allow_inf_nan=False)


def slot_times(session):
    if not session["verified"] or not session["opens"] or not session["closes"]:
        return []
    opened, closed = (datetime.fromtimestamp(session[key], IST) for key in ("opens", "closes"))
    if opened.time() != OPEN or not CLOSE <= closed.time() <= time(15, 45):
        return []
    step = timedelta(seconds=BAR_SECONDS)
    first = opened + timedelta(seconds=BAR_SECONDS + READY_LAG_SECONDS)
    # The official cash close may include the post-continuous auction.
    end = datetime.combine(opened.date(), CLOSE, IST) + timedelta(seconds=READY_LAG_SECONDS)
    return [("premarket", opened - timedelta(minutes=15)), *[
        (point.strftime("%H:%M"), point)
        for index in range(1 + int((end - first) / step))
        if (point := first + index * step) <= end
    ]]


def phase_for(now, session):
    if not session["verified"]:
        return "unverified"
    if not (slots := slot_times(session)):
        return "closed"
    stamp = int(now.timestamp())
    if stamp < session["opens"]:
        return "premarket"
    end = int(slots[-1][1].timestamp()) - READY_LAG_SECONDS
    return "open" if stamp < end else "after-hours"


def _day_bars(rows, day, through):
    return [Candle(**row) for row in rows if row["time"] + BAR_SECONDS <= through
            and (stamp := datetime.fromtimestamp(row["time"], IST)).date().isoformat() == day
            and OPEN <= stamp.time() < CLOSE]


def _prior_bars(rows, day):
    return [Candle(**row) for row in rows if (stamp := datetime.fromtimestamp(row["time"], IST)).date().isoformat() < day
            and OPEN <= stamp.time() < LAST_CONTINUOUS_BAR]


def _number(raw, fallback=0.0):
    result = _num(raw)
    return result if result is not None else fallback


def _stamp(raw):
    for pattern in ("%Y-%m-%d %H:%M:%S", "%d-%b-%Y %H:%M:%S", "%d-%b-%Y %H:%M", "%d-%b-%Y"):
        try:
            return datetime.strptime(raw or "", pattern).replace(tzinfo=IST)
        except (TypeError, ValueError):
            continue
    return None


def _load(future, fallback, source, warnings):
    try:
        return future.result()
    except Exception as exc:
        logger.info("Daily desk source %s unavailable (%s)", source, type(exc).__name__)
        warnings.append(f"{source} was unavailable for this scan.")
        return fallback


def _candidates(master, previous, active, preopen, retained, now, include_active, *, paper=False, tracked=None):
    tracked = tracked or {}
    by_symbol = {item["SYMBOL"]: item for item in master if item.get("SYMBOL") and item.get("SERIES", "EQ") == "EQ"}
    previous_day, data = previous
    prior = {item["TckrSymb"]: item for item in data
             if item.get("TckrSymb") in by_symbol and item.get("SctySrs") == "EQ"
             and _number(item.get("ClsPric")) >= (0.01 if paper else 50)}
    ranked = sorted(prior, key=lambda sym: _number(prior[sym].get("TtlTrfVal")), reverse=True)
    active_by_symbol = {}
    if include_active:
        for item in active.get("data", ()):
            stamp = _stamp(item.get("lastUpdateTime") or active.get("timestamp"))
            symbol = item.get("symbol")
            if (symbol in (by_symbol if paper else prior) and stamp and stamp.date() == now.date()
                    and stamp <= now + timedelta(seconds=30)
                    and 0 <= (now - stamp).total_seconds() <= 900):
                active_by_symbol[symbol] = item

    indicative = {}
    for item in preopen.get("data", ()):
        meta = item.get("metadata") or {}
        book = (item.get("detail") or {}).get("preOpenMarket") or {}
        stamp = _stamp(book.get("lastUpdateTime") or meta.get("lastUpdateTime"))
        symbol = meta.get("symbol")
        if symbol in prior and stamp and stamp.date() == now.date() and stamp <= now:
            indicative[symbol] = {"preopen_price": _num(book.get("IEP") or meta.get("iep")),
                                  "preopen_at": stamp.isoformat()}
    defaults = [item["symbol"].removesuffix(".NS") for item in DEFAULTS if item["kind"] == "stock"]
    fallback_names = {item["symbol"].removesuffix(".NS"): item["name"] for item in DEFAULTS if item["kind"] == "stock"}
    core = list(dict.fromkeys([*retained, *active_by_symbol, *indicative, *ranked, *defaults]))
    core = core[:PAPER_ACTIVE_NAMES if paper else 14]
    symbols = list(dict.fromkeys([*(symbol.removesuffix(".NS") for symbol in tracked), *core]))
    if paper:
        already = set(symbols)
        rotation = [symbol for symbol in ranked if symbol not in already]
        if rotation:
            slot = (now.hour * 60 + now.minute - 9 * 60 - 15) // 5
            first = ((now.date().toordinal() * 73 + slot) * PAPER_ROTATION) % len(rotation)
            symbols.extend((rotation[first:] + rotation[:first])[:PAPER_ROTATION])
    output = []
    for symbol in symbols:
        meta, old, active_quote = by_symbol.get(symbol, {}), prior.get(symbol, {}), active_by_symbol.get(symbol, {})
        tracked_asset = tracked.get(f"{symbol}.NS", {})
        price, prev = _num(old.get("ClsPric")), _num(old.get("PrvsClsgPric"))
        output.append({
            "symbol": f"{symbol}.NS",
            "name": meta.get("NAME OF COMPANY") or tracked_asset.get("name") or fallback_names.get(symbol, symbol),
            "isin": meta.get("ISIN NUMBER") or old.get("ISIN") or tracked_asset.get("isin"), "prior_close": price,
            "prior_change": round((price / prev - 1) * 100, 2) if price and prev else None,
            "turnover": _num(active_quote.get("totalTradedValuecsv")) or _num(old.get("TtlTrfVal")),
            "turnover_source": "NSE intraday turnover" if active_quote else "NSE prior-session turnover",
            "prior_session": previous_day, "last": None, "as_of": None, "feed": None, "fresh": False,
            **indicative.get(symbol, {}),
        })
    return output


def _evidence(filings, candidates, decision_time):
    selected = {item["symbol"].removesuffix(".NS") for item in candidates}
    result = []
    for entry in filings:
        stamp = _stamp(entry.get("exchdisstime")) or _stamp(entry.get("sort_date")) or _stamp(entry.get("an_dt"))
        if entry.get("symbol") not in selected or not stamp or stamp > decision_time:
            continue
        try:
            link = urlsplit(entry.get("attchmntFile") or "")
        except ValueError:
            continue
        if link.scheme != "https" or link.hostname not in {
            "www.nseindia.com", "www.nseindia.in", "nsearchives.nseindia.com", "archives.nseindia.com",
            "nsearchives.nseindia.in", "archives.nseindia.in",
        }:
            continue
        result.append({
            "symbol": f"{entry['symbol']}.NS", "at": stamp.isoformat(), "timestamp": stamp.isoformat(),
            "title": str(entry.get("desc") or "Company filing")[:160],
            "summary": " ".join(str(entry.get("attchmntText") or "").split())[:550],
            "url": link.geturl(), "link": link.geturl(),
        })
    return sorted(result, key=lambda entry: entry["at"], reverse=True)[:12]


def _scan_asset(asset, day, now, open_for_signals, budget):
    returned, source, mode = provider.intraday(asset["symbol"], asset.get("isin") or "", day)
    today = _day_bars(returned, day, int(now.timestamp()))
    try:
        prior_data = provider.history(asset["symbol"], day)
    except (OSError, RuntimeError, ValueError, VendorError):
        prior_data = []
    as_of = today[-1].time + BAR_SECONDS if today else None
    late = int(now.timestamp()) - as_of if as_of is not None else None
    fresh = late is not None and 0 <= late <= 2 * BAR_SECONDS
    prior = _prior_bars(prior_data, day)
    strategy_bars = [bar for bar in today if bar.local.time() < LAST_CONTINUOUS_BAR and bar.volume > 0]
    prior_close = None if asset.get("corporate_action") else asset.get("prior_close")
    ideas, _ = evaluate(prior, strategy_bars, prior_close, budget)
    prepared = [{**asdict(bar), "vwap": round(feature["vwap"], 4)}
                for bar, feature in zip(today, indicators(prior, today), strict=True)]
    source_ready = bool(open_for_signals and fresh and mode == "authenticated" and now.time() < ENTRY_CUTOFF)
    updated = {**asset, "last": today[-1].close if today else None, "as_of": as_of,
               "feed": source, "fresh": fresh, "mode": mode}
    return updated, prepared, [
        {**idea, "symbol": asset["symbol"], "name": asset["name"], "as_of": as_of,
         **({"status": "data-gap", "exit_reason": "No continuous-session exit candle was available."}
            if now.time() >= LAST_CONTINUOUS_BAR and idea["status"] == "open" else {}),
         "live": source_ready, "fresh": fresh, "feed": source}
        for idea in ideas
    ]


def _fresh_book(quote, stamp):
    return bool(quote and 0 <= stamp - quote["at"] <= 60 and 0 <= stamp - quote["last_trade_at"] <= 90)


def _within_entry(idea, size, quote, now):
    stamp = int(now.timestamp())
    return bool(idea["status"] == "confirmed" and idea.get("confirmation_at")
                and 0 <= stamp - idea["confirmation_at"] < BAR_SECONDS and _fresh_book(quote, stamp)
                and idea["confirmation_at"] <= quote["at"] and idea["trigger"] <= quote["ask"] <= idea["entry_cap"]
                and quote["ask"] - quote["bid"] <= quote["ask"] * 0.0015 and size
                and 0 < size["quantity"] <= quote["ask_quantity"])


class DailyDesk:
    def __init__(self, config):
        self.config = config
        self.root = Path(config["results_dir"]) / "dashboard" / "daily"
        self.paper = DailyPaper(self.root / "auto-paper.json")
        self.enabled = os.getenv("TRADINGAGENTS_DAILY_ENABLED", "1").lower() not in {"0", "false", "no"}
        self.wake, self.closed = Event(), Event()
        self.guard = Lock()
        self.request = None
        self.running = False
        self.status = ""
        self.cooldown = 0.0
        self.session = _EMPTY
        self.session_day = ""
        self.checked_calendar = 0.0
        self.next_open = None
        self.thread = None

    def start(self):
        self.root.mkdir(parents=True, exist_ok=True)
        self.thread = Thread(target=self._loop, daemon=True, name="tradingagents-daily-desk")
        self.thread.start()

    def stop(self):
        self.closed.set()
        self.wake.set()

    def path(self, day, file):
        return self.root / day / file

    @staticmethod
    def _read(path, fallback):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return fallback

    def _save(self, path, record):
        path.parent.mkdir(parents=True, exist_ok=True)
        replace_file(path, lambda target: Path(target).write_text(
            json.dumps(record, ensure_ascii=False, allow_nan=False), encoding="utf-8",
        ))

    def budget(self, day):
        return self._read(self.path(day, "budget.json"), {}).get("budget", 5000)

    def set_budget(self, amount):
        self._save(self.path(datetime.now(IST).date().isoformat(), "budget.json"), {"budget": round(amount, 2)})
        return self.view()

    def set_auto_trade(self, settings, now=None):
        now = now or datetime.now(IST)
        if settings.enabled and not self.enabled:
            raise ValueError("Enable the Daily Trading scheduler to run Auto trade.")
        self.paper.configure(settings, now)
        self.wake.set()
        return self.view(now=now)

    def enqueue(self, operation):
        with self.guard:
            if self.running or self.request is not None or monotonic() < self.cooldown:
                return False
            self.request = operation
            self.wake.set()
        return True

    def _calendar(self, now):
        day = now.date().isoformat()
        if (self.session_day == day and (self.next_open is None or self.next_open > now)
                and monotonic() - self.checked_calendar < (900 if self.session["verified"] else 120)):
            return
        try:
            session = provider.session_for(day)
        except Exception as exc:
            logger.info("Daily calendar check failed (%s)", type(exc).__name__)
            session = _EMPTY
        self.session_day, self.session, self.checked_calendar = day, session, monotonic()
        if session.get("verified") and session.get("opens") and not slot_times(session):
            self.session = {**session, "note": "Special session hours are outside the regular-session strategy."}
        self.next_open = None
        if not self.enabled or phase_for(now, session) == "unverified":
            return
        future = [stamp for _, stamp in slot_times(session) if stamp > now]
        if future:
            self.next_open = future[0]
            return
        for shift in range(1, 8):
            try:
                following = provider.session_for((now.date() + timedelta(days=shift)).isoformat())
            except Exception:
                continue
            if slots := slot_times(following):
                self.next_open = slots[0][1]
                return

    def _loop(self):
        while not self.closed.is_set():
            self.wake.clear()
            try:
                self.tick()
            except Exception as exc:
                logger.warning("Daily desk tick did not finish (%s)", type(exc).__name__)
                self.status = f"The last scan could not finish ({type(exc).__name__})."
            self.wake.wait(15)

    def tick(self, now=None):
        now = now or datetime.now(IST)
        day = now.date().isoformat()
        self._calendar(now)
        current = self._read(self.path(day, "scan.json"), {})
        slots = slot_times(self.session)
        due = [(name, stamp) for name, stamp in slots if stamp <= now]
        scheduled = due[-1][0] if self.enabled and due and due[-1][0] != current.get("slot") else None
        if scheduled and current.get("slot") is None and now - due[-1][1] > timedelta(minutes=45):
            scheduled = None
        if scheduled and not self.running and now - due[-1][1] > timedelta(minutes=10):
            scheduled = None
        _, _, wrap_up = self.paper.inputs(day, now.time())
        if self.enabled and wrap_up and slots:
            scheduled = slots[-1][0]
        with self.guard:
            requested, self.request = self.request, None
            if not requested and not scheduled:
                return
            self.running = True
        try:
            self.status = ""
            if requested == "replay":
                from .daily_research import replay_summary

                self._save(self.path(day, "replay.json"), replay_summary(current.get("candidates", []), day, self.budget(day)))
            elif requested == "scan" or scheduled:
                self._scan(day, now, due[-1][0] if due else "manual", current)
        finally:
            with self.guard:
                self.running = False
                self.cooldown = monotonic() + 8

    def _scan(self, day, now, slot, current):
        phase = phase_for(now, self.session)
        before_open = phase == "premarket"
        if not slot_times(self.session):
            self.status = "Waiting for a verified regular NSE cash session."
            return
        warnings = []
        try:
            skill = SKILL.read_text(encoding="utf-8")
        except OSError:
            skill = ""
            warnings.append("The daily strategy skill could not be read.")
        bucket = int(now.timestamp() // BAR_SECONDS)
        prior_day = (now.date() - timedelta(days=1)).isoformat()
        with ThreadPoolExecutor(max_workers=5) as pool:
            pending = {
                "NSE security master": (pool.submit(nse.securities, "stock", day), ()),
                "Prior NSE session": (pool.submit(nse.last_bhavcopy, prior_day), ("", ())),
            }
            if before_open:
                pending["NSE pre-open auction"] = (pool.submit(provider.preopen_equities, bucket), {})
            else:
                pending["NSE activity"] = (pool.submit(provider.active_equities, bucket), {})
            if phase == "open":
                pending["NSE market status"] = (pool.submit(provider.market_status, bucket), {})
            pending["NSE disclosures"] = (pool.submit(provider.disclosures, day), [])
            pending["NSE corporate actions"] = (pool.submit(provider.corporate_actions, day, bucket // 3), [])
            data = {name: _load(task, fallback, name, warnings) for name, (task, fallback) in pending.items()}

        retained = [idea["symbol"].removesuffix(".NS") for idea in current.get("ideas", [])
                    if idea["status"] in {"confirmed", "open"}]
        paper_active, tracking, _ = self.paper.inputs(day, now.time())
        candidates = _candidates(data["NSE security master"], data["Prior NSE session"], data.get("NSE activity", {}),
                                 data.get("NSE pre-open auction", {}), retained, now, phase != "premarket",
                                 paper=paper_active and phase == "open", tracked=tracking)
        actions = {f"{item['symbol']}.NS": item.get("subject", "Corporate action") for item in data["NSE corporate actions"]
                   if item.get("symbol") and (ex := _stamp(item.get("exDate"))) and ex.date() == now.date()}
        for row in candidates:
            if row["symbol"] in actions:
                row["corporate_action"] = actions[row["symbol"]]
        venue = next((item for item in data.get("NSE market status", {}).get("marketState", [])
                      if item.get("market") == "Capital Market"), {})
        market_date = _stamp(venue.get("tradeDate"))
        market_open = venue.get("marketStatus", "").strip().casefold() == "open" and (
            market_date is None or market_date.date() == now.date()
        )
        if phase == "open" and not market_open:
            warnings.append("NSE continuous market status has not been confirmed for this scan.")

        brief = current.get("brief")
        recent_filings = _evidence(data.get("NSE disclosures", []), candidates, now)
        if not brief or (before_open and slot == "premarket" and current.get("slot") != "premarket"):
            from .daily_research import daily_brief

            model_window = before_open and slot == "premarket"
            brief = daily_brief(candidates, recent_filings,
                                self.config, self.path(day, "model_log.jsonl"), skill if model_window else "",
                                before_open, SOURCES)

        charts, ideas, scanned = {}, [], []
        if not before_open:
            budget = self.budget(day)
            with ThreadPoolExecutor(max_workers=8 if paper_active else 6) as pool:
                tasks = [pool.submit(_scan_asset, asset, day, now, market_open, budget) for asset in candidates]
                for asset, task in zip(candidates, tasks, strict=True):
                    updated, bars, found = _load(task, (asset, [], []), asset["symbol"], warnings)
                    if bars:
                        charts[asset["symbol"]] = {"bars": bars, "as_of": updated["as_of"], "source": updated["feed"]}
                    scanned.append(updated)
                    ideas.extend(found)
        for idea in ideas:
            idea["id"] = f"{idea['symbol']}:{idea['strategy']}"
        if phase == "open" and market_open:
            try:
                quotes = provider.live_quotes(scanned, day)
            except (OSError, ValueError, TypeError, AttributeError):
                quotes = {}
                warnings.append("The Upstox quote book was unavailable for this scan.")
            if quotes:
                for row in scanned:
                    if quote := quotes.get(row["symbol"]):
                        row["live_quote"] = quote
                for idea in ideas:
                    idea["live_quote"] = quotes.get(idea["symbol"])
        feeds = sorted({row["feed"] for row in scanned if row.get("feed")})
        broker = any(row.get("mode") == "authenticated" for row in scanned)
        self._save(self.path(day, "scan.json"), {
            "day": day, "slot": slot, "updated_at": now.isoformat(), "brief": brief, "session": self.session,
            "candidates": scanned or candidates, "ideas": ideas, "charts": charts, "warnings": warnings,
            "latest_filings": recent_filings,
            "feed": {"name": " · ".join(feeds) or "NSE session data", "mode": "broker" if broker else "reference",
                     "note": "Entry indications also check the current ask, spread, available size, and NSE session." if broker else
                     "Public candles support research and replay. Add an Upstox Analytics Token for broker-confirmed indications."},
        })
        observed_at = datetime.now(IST)
        if observed_at.date().isoformat() == day and not before_open:
            venue_report = venue.get("marketStatus", "").strip()
            # A verified calendar and completed bars are sufficient for paper trading when status is unavailable.
            paper_open = market_open or not venue_report or (market_date and market_date.date() != now.date())
            self.paper.advance(observed_at, phase_for(observed_at, self.session), self.budget(day), scanned,
                               charts, ideas, bool(paper_open))

    def view(self, day=None, now=None):
        now = now or datetime.now(IST)
        today = now.date().isoformat()
        day = day or today
        snapshot = self._read(self.path(day, "scan.json"), {})
        budget = self.budget(day)
        session = (self.session if self.session_day == day else _EMPTY) if day == today else snapshot.get("session", _EMPTY)
        upcoming = [stamp for _, stamp in slot_times(session) if stamp > now]
        next_scan = (upcoming[0] if upcoming else self.next_open) if self.enabled else None
        phase = phase_for(now, session) if day == today else "after-hours"
        warnings = list(snapshot.get("warnings", ()))
        if day == today and self.status:
            warnings.append(self.status)
        ideas = []
        for idea in snapshot.get("ideas", ()):
            age = int(now.timestamp()) - (idea.get("as_of") or 0)
            fresh = bool(day == today and phase == "open" and 0 <= age <= 2 * BAR_SECONDS)
            size = position_size(idea.get("entry") or idea["entry_cap"], idea["stop"], idea["target"], budget)
            live = bool(idea["live"] and fresh and now.time() < ENTRY_CUTOFF and size and size["quantity"] > 0
                        and _within_entry(idea, size, idea.get("live_quote"), now))
            ideas.append({**idea, "size": size, "live": live, "fresh": fresh})
        candidates = []
        for row in snapshot.get("candidates", []):
            age = int(now.timestamp()) - (row.get("as_of") or 0)
            candidates.append({**row, "fresh": day == today and phase == "open" and 0 <= age <= 2 * BAR_SECONDS})
        paper = self.paper.view(day)
        dates = {path.parent.name for path in self.root.glob("*/scan.json")}
        dates.update(item["day"] for item in paper["history"])
        return {
            **{key: value for key, value in snapshot.items() if key != "charts"},
            "day": day, "budget": budget, "phase": phase, "scheduled": self.enabled,
            "next_scan": next_scan.isoformat() if next_scan else None, "running": self.running,
            "candidates": candidates, "ideas": ideas, "warnings": warnings,
            "research": self._read(self.path(day, "replay.json"), None),
            "history": sorted(dates, reverse=True)[:45], "auto_trade": paper,
            "session": session, "model_log": self.path(day, "model_log.jsonl").is_file(),
        }

    def chart(self, symbol, day):
        snapshot = self._read(self.path(day, "scan.json"), {})
        return {"symbol": symbol, "day": day, **snapshot.get("charts", {}).get(symbol, {"bars": []})}
