"""Forward-only intraday paper trading against the daily desk's completed candles."""

from __future__ import annotations

import json
import logging
import math
from collections import Counter
from datetime import datetime, time
from decimal import Decimal
from pathlib import Path
from threading import RLock

from pydantic import BaseModel, Field

from tradingagents.dataflows.files import replace_file
from tradingagents.diagnostics import event, trace_context

from .daily_strategy import (
    BAR_SECONDS,
    DEFAULT_RISK_BPS,
    ENTRY_CUTOFF,
    IST,
    LAST_CONTINUOUS_BAR,
    MIN_RISK_BPS,
    PAPER_STRATEGIES,
    SHORT_STRATEGY,
    STRATEGIES,
    Candle,
    in_entry_range,
    leg_cost,
    long_exit,
    position_size,
    short_exit,
)
from .workspace_store import ZERO, cash_value

FINAL_SCAN = time(15, 31)
ENTRY_LAG_TOLERANCE = 60
logger = logging.getLogger(__name__)


class AutoTradeSettings(BaseModel):
    enabled: bool
    sessions: int = Field(default=5, ge=1, le=5)
    risk_bps: int = Field(default=DEFAULT_RISK_BPS, ge=MIN_RISK_BPS, le=DEFAULT_RISK_BPS)
    allow_shorts: bool = False


def _money(price, quantity):
    return cash_value(Decimal(str(price)) * quantity)


def _fees(side, price, quantity):
    return cash_value(Decimal(str(leg_cost(side, float(_money(price, quantity))))))


def _required(price, quantity, side):
    return _money(price, quantity) + _fees(side, price, quantity)


def _size(idea, cash, budget, risk_bps, short):
    entry, stop = idea["entry_cap"], idea["stop"]
    plan = position_size(entry, stop, idea["target"], float(budget), short=short, risk_bps=risk_bps)
    if not plan or plan["reward_risk"] < 1.5:
        return 0
    risk_limit = budget * risk_bps / 10_000
    funding_price = max(entry, idea["trigger"])
    entry_side, exit_side = ("sell", "buy") if short else ("buy", "sell")
    low, high = 0, min(plan["quantity"], math.floor(cash / Decimal(str(funding_price))))
    while low < high:
        quantity = (low + high + 1) // 2
        risk = abs(_money(entry, quantity) - _money(stop, quantity))
        risk += _fees(entry_side, entry, quantity) + _fees(exit_side, stop, quantity)
        if _required(funding_price, quantity, entry_side) <= cash and risk <= risk_limit:
            low = quantity
        else:
            high = quantity - 1
    return low


def _new_day(day, budget, trial):
    return {
        "day": day, "budget": str(cash_value(Decimal(str(budget)))), "orders": [], "pending": {}, "positions": {},
        "seen": [], "skipped": {}, "scanned": [], "scans": 0, "last_scan": None, "closed": False,
        "peak_invested": "0.00", "activity": [],
        "risk_bps": trial.get("risk_bps", DEFAULT_RISK_BPS), "allow_shorts": trial.get("allow_shorts", False),
    }


def _skip(book, skipped, symbol, strategy, explanation, **prices):
    book["skipped"][explanation] = book["skipped"].get(explanation, 0) + 1
    skipped.append({"symbol": symbol, "strategy": strategy, "reason": explanation, **prices})


def _candles(chart, now):
    for bar in chart.get("bars", []):
        if bar["time"] + BAR_SECONDS <= now and bar["volume"] > 0:
            candle = Candle(bar["time"], bar["open"], bar["high"], bar["low"], bar["close"], bar["volume"])
            if candle.local.time() < LAST_CONTINUOUS_BAR:
                yield candle


def _fill(book, position, side, price, observed_at, recorded_at, source, reason, bar_at):
    price = round(price, 2)
    quantity = position["quantity"]
    fees = _fees(side, price, quantity)
    order = {
        "asset": position["asset"], "strategy": position["strategy"], "side": side,
        "units": quantity, "price": price, "fee": str(fees), "at": observed_at, "recorded_at": recorded_at,
        "reason": reason, "source": source, "signal_at": position["signal_at"], "submitted_at": position["submitted_at"],
        "bar_at": bar_at, "signal_reason": position.get("signal_reason"),
        "direction": position.get("direction", "long"),
    }
    if side == ("buy" if order["direction"] == "short" else "sell"):
        order["net"] = str(_open_result(position, price))
    book["orders"].append(order)
    return _money(price, quantity) + fees


def _manage_position(book, symbol, position, bars, chart, stamp):
    short = position.get("direction") == "short"
    exit_rule = short_exit if short else long_exit
    for bar in bars:
        if bar.time < position["next_bar"]:
            continue
        if short and (position.get("data_gap") or bar.time != position["next_bar"]):
            # An unobserved interval could contain a stop or an unavailable cover.
            position.update(data_gap=True, next_bar=bar.time + BAR_SECONDS, mark=bar.close,
                            mark_at=bar.time + BAR_SECONDS)
            continue
        if bar.time != position["next_bar"]:
            # A missing interval prevents reconstructing which level was touched first.
            outcome = (bar.open, "gap-exit", bar.time)
        else:
            outcome = exit_rule(bar, position["stop"], position["target"])
        if outcome:
            price, reason, at = outcome
            _fill(book, position, "buy" if short else "sell", price, at, stamp, chart.get("source"), reason, bar.time)
            del book["positions"][symbol]
            return
        position.update(next_bar=bar.time + BAR_SECONDS, mark=bar.close, mark_at=bar.time + BAR_SECONDS)


def _orders_for_scan(book, charts, stamp, live_entries, skipped):
    for symbol, position in list(book["positions"].items()):
        chart = charts.get(symbol, {})
        _manage_position(book, symbol, position, _candles(chart, stamp), chart, stamp)

    for symbol, order in list(book["pending"].items()):
        enter_at = order["enter_at"]
        if not live_entries:
            del book["pending"][symbol]
            _skip(book, skipped, symbol, order["strategy"], "Entry paused or session closed")
            continue
        chart = charts.get(symbol, {})
        bars = list(_candles(chart, stamp))
        start = next((bar for bar in bars if bar.time == enter_at), None)
        if stamp > enter_at + 2 * BAR_SECONDS + ENTRY_LAG_TOLERANCE:
            del book["pending"][symbol]
            _skip(book, skipped, symbol, order["strategy"], "Entry candle arrived too late")
            continue
        if start is None:
            continue
        del book["pending"][symbol]
        price = round(start.open, 2)
        if not in_entry_range(order, price):
            lower, upper = sorted((order["trigger"], order["entry_cap"]))
            _skip(book, skipped, symbol, order["strategy"], "Opening price outside entry range",
                  opening_price=price, minimum_price=lower, maximum_price=upper, entry_at=enter_at)
            continue
        held = {**order, "entry": price, "entry_at": enter_at, "next_bar": enter_at, "mark": price, "mark_at": enter_at}
        side = "sell" if order.get("direction") == "short" else "buy"
        held["cost"] = str(_fill(book, held, side, price, enter_at, stamp, chart.get("source"), "candle-open", start.time))
        book["positions"][symbol] = held
        invested = sum((Decimal(pos["cost"]) for pos in book["positions"].values()), ZERO)
        book["peak_invested"] = str(max(invested, Decimal(book["peak_invested"])))
        _manage_position(book, symbol, held, bars, chart, stamp)


def _queue(book, ideas, candidates, stamp, trial, skipped):
    enter_at = (stamp // BAR_SECONDS + 1) * BAR_SECONDS
    if datetime.fromtimestamp(enter_at, IST).time() >= ENTRY_CUTOFF:
        return [], None
    budget, cash, _, invested = _account(book)
    reserved = sum((Decimal(order["reserved"]) for order in book["pending"].values()), ZERO)
    available = min(cash, budget - invested) - reserved
    assets = {item["symbol"]: item for item in candidates}
    risk_bps = trial.get("risk_bps", DEFAULT_RISK_BPS)
    fresh = [idea for idea in ideas if idea["status"] == "confirmed" and idea.get("confirmation_at", 0) >= trial["armed_at"]
             and 0 <= stamp - idea["confirmation_at"] < BAR_SECONDS]
    fresh.sort(key=lambda idea: (-(idea["size"] or {}).get("reward_risk", 0),
                                 -(idea.get("relative_volume") or 0), idea["symbol"], idea["strategy"]))
    seen, queued, checked = set(book["seen"]), [], 0
    for idea in fresh:
        symbol = idea["symbol"]
        short = idea["strategy"] == SHORT_STRATEGY
        if short and not (trial.get("allow_shorts") and assets.get(symbol, {}).get("short_eligible")):
            continue
        signal_id = f"{symbol}:{idea['strategy']}:{idea['confirmation_at']}"
        if signal_id in seen:
            continue
        seen.add(signal_id)
        checked += 1
        if symbol in book["positions"] or symbol in book["pending"]:
            _skip(book, skipped, symbol, idea["strategy"], "Stock already held or queued")
            continue
        if symbol not in assets:
            _skip(book, skipped, symbol, idea["strategy"], "Stock details unavailable")
            continue
        quantity = _size(idea, available, budget, risk_bps, short)
        if quantity <= 0:
            _skip(book, skipped, symbol, idea["strategy"], "Cash or risk limit")
            continue
        funding_price = max(idea["entry_cap"], idea["trigger"])
        used = _required(funding_price, quantity, "sell" if short else "buy")
        market_asset = assets[symbol]
        book["pending"][symbol] = {
            "strategy": idea["strategy"], "quantity": quantity, "enter_at": enter_at,
            "entry_cap": idea["entry_cap"], "trigger": idea["trigger"], "stop": idea["stop"], "target": idea["target"],
            "reserved": str(used), "signal_at": idea["confirmation_at"], "submitted_at": stamp,
            "signal_reason": idea.get("reason"),
            "direction": "short" if short else "long",
            "risk_bps": risk_bps,
            "asset": {key: market_asset.get(key) for key in ("symbol", "name", "isin")},
        }
        queued.append(book["pending"][symbol])
        available -= used
    book["seen"] = sorted(seen)
    return queued, checked


def _open_result(position, price=None):
    price, quantity = position["mark"] if price is None else price, position["quantity"]
    if position.get("direction") == "short":
        entry = position["entry"]
        return (_money(entry, quantity) - _fees("sell", entry, quantity)
                - _money(price, quantity) - _fees("buy", price, quantity))
    return _money(price, quantity) - _fees("sell", price, quantity) - Decimal(position["cost"])


def _account(book):
    budget = Decimal(book["budget"])
    realized = sum((Decimal(order["net"]) for order in book["orders"] if "net" in order), ZERO)
    invested = sum((Decimal(position["cost"]) for position in book["positions"].values()), ZERO)
    # The simulator reserves a short's entire notional and does not reuse its proceeds.
    return budget, budget + realized - invested, realized, invested


def _summary(book):
    budget, cash, realized, invested = _account(book)
    outcomes = [order for order in book["orders"] if "net" in order]
    buys = sum(order["side"] == "buy" for order in book["orders"])
    open_count = len(book["positions"])
    reserved = sum((Decimal(item["reserved"]) for item in book["pending"].values()), ZERO)
    fees = sum((Decimal(item["fee"]) for item in book["orders"]), ZERO)
    holdings = book["positions"].values()
    available = max(ZERO, min(cash, budget - invested) - reserved)
    net_open = sum((_open_result(pos) for pos in holdings), ZERO)
    money = {
        "budget": book["budget"], "cash": str(cash), "reserved": str(reserved), "available": str(available),
        "realized": str(realized), "unrealized": str(net_open),
        "total_result": str(realized + net_open), "invested": str(invested),
        "peak_invested": book["peak_invested"], "costs": str(fees),
    }
    return {
        "day": book["day"], "closed": book["closed"], "fills": len(book["orders"]), "trades": len(outcomes),
        "buys": buys, "sells": len(book["orders"]) - buys,
        "wins": sum(Decimal(item["net"]) > 0 for item in outcomes), "unresolved": open_count if book["closed"] else 0,
        "open": open_count, "pending": len(book["pending"]), "scans": book["scans"],
        "candidates": len(book["scanned"]), "last_scan": book["last_scan"],
        "risk_bps": book.get("risk_bps", DEFAULT_RISK_BPS), "allow_shorts": book.get("allow_shorts", False), **money,
    }


class DailyPaper:
    """Persist trial controls, commitments and fills in one atomic local state."""

    def __init__(self, path: Path):
        self.path = path
        self.guard = RLock()

    def _load(self):
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"trial": None, "books": {}}

    def _save(self, state):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        replace_file(self.path, lambda target: Path(target).write_text(
            json.dumps(state, allow_nan=False), encoding="utf-8",
        ), strict=True)

    def configure(self, settings, now):
        with self.guard:
            state = self._load()
            trial = state["trial"]
            cancelled = 0
            if settings.enabled:
                if not trial or not trial["enabled"]:
                    state["trial"] = {
                        "enabled": True, "limit": settings.sessions, "days": [], "armed_at": int(now.timestamp()),
                        "risk_bps": settings.risk_bps, "allow_shorts": settings.allow_shorts,
                    }
            elif trial and trial["enabled"]:
                trial["enabled"] = False
                trial["ended_by"] = "user"
                for book in state["books"].values():
                    if book["pending"]:
                        cancelled += len(book["pending"])
                        book["skipped"]["Stopped before entry"] = book["skipped"].get("Stopped before entry", 0) + len(book["pending"])
                        book["pending"].clear()
            self._save(state)
        event(logger, "paper.settings_saved", "Auto Trade settings saved", enabled=settings.enabled, sessions=settings.sessions,
              cancelled_entries=cancelled, risk_bps=settings.risk_bps, allow_shorts=settings.allow_shorts)

    def short_entries_enabled(self):
        with self.guard:
            trial = self._load()["trial"] or {}
            return bool(trial.get("enabled") and trial.get("allow_shorts"))

    def inputs(self, day, time_of_day):
        with self.guard:
            state = self._load()
            trial = state["trial"]
            book = state["books"].get(day, {})
            tracking = {**book.get("positions", {}), **book.get("pending", {})}
            active = bool(trial and trial["enabled"] and not book.get("closed") and time_of_day < ENTRY_CUTOFF
                          and (day in trial["days"] or len(trial["days"]) < trial["limit"]))
            wrap_up = bool(book and not book["closed"] and time_of_day >= FINAL_SCAN)
            return active, {symbol: item["asset"] for symbol, item in tracking.items()}, wrap_up

    def advance(self, now, phase, budget, candidates, charts, ideas, allow_new):
        day, stamp = now.date().isoformat(), int(now.timestamp())
        with self.guard:
            state = self._load()
            trial, books = state["trial"], state["books"]
            book = books.get(day)
            changed = False
            for older in books.values():
                if older["day"] < day and not older["closed"]:
                    older["closed"] = True
                    older["pending"].clear()
                    changed = True
                    if trial and older["day"] in trial["days"] and len(trial["days"]) >= trial["limit"] and trial["enabled"]:
                        trial.update(enabled=False, ended_by="completed")
            active = bool(trial and trial["enabled"] and stamp >= trial["armed_at"]
                          and (day in trial["days"] or len(trial["days"]) < trial["limit"]))
            if active and phase == "open" and now.time() < ENTRY_CUTOFF and (not book or not book["closed"]):
                if day not in trial["days"]:
                    trial["days"].append(day)
                if not book:
                    book = books[day] = _new_day(day, budget, trial)
            if not book or book["closed"]:
                if changed:
                    self._save(state)
                return {order["asset"]["symbol"] for order in book["orders"]} if book else set()
            trading = bool(active and phase == "open" and allow_new)
            first_fill, skipped = len(book["orders"]), []
            _orders_for_scan(book, charts, stamp, trading, skipped)
            queued, checked = [], None
            if trading and now.time() < ENTRY_CUTOFF:
                book.update(risk_bps=trial.get("risk_bps", DEFAULT_RISK_BPS),
                            allow_shorts=trial.get("allow_shorts", False))
                queued, checked = _queue(book, ideas, candidates, stamp, trial, skipped)
            book["scans"] += 1
            book["last_scan"] = stamp
            for symbol in charts:
                if symbol not in book["scanned"]:
                    book["scanned"].append(symbol)
            if phase == "after-hours" and now.time() >= FINAL_SCAN:
                book["closed"] = True
                if active and day in trial["days"] and len(trial["days"]) >= trial["limit"]:
                    trial.update(enabled=False, ended_by="completed")
            if phase != "open":
                mode = "market-closed"
            elif not active:
                mode = "buys-paused"
            elif not allow_new:
                mode = "market-unverified"
            else:
                mode = "checking-buys" if checked is not None else "buy-window-ended"
            book.setdefault("activity", []).append({
                "number": book["scans"], "at": stamp, "mode": mode, "signals": checked,
                "scan_id": trace_context().get("scan_id"),
                "checked": [{"symbol": row["symbol"], "name": row.get("name"),
                             "price_at": charts.get(row["symbol"], {}).get("as_of"),
                             "price": row.get("last"),
                             "has_prices": row["symbol"] in charts} for row in candidates],
                "first_fill": first_fill, "fill_count": len(book["orders"]) - first_fill,
                "queued": queued, "skipped": skipped, "open": len(book["positions"]),
                "waiting": len(book["pending"]),
            })
            self._save(state)
        orders = book["orders"][first_fill:]
        event(logger, "paper.check_saved", "Paper trade decisions saved for the market check",
              date=day, check=book["scans"], mode=mode, signals=checked, checked=len(candidates), priced=len(charts),
              queued=len(queued), skipped=len(skipped), open=len(book["positions"]), fills=len(orders))
        for order in orders:
            event(logger, f"paper.{order['side']}", "Simulated order completed", date=day, check=book["scans"],
                  symbol=order["asset"]["symbol"], strategy=order["strategy"], price=order["price"], shares=order["units"],
                  fee=order["fee"], direction=order["direction"], result=order.get("net"),
                  market_at=order["at"], reason=order["reason"])
        for order in queued:
            lower, upper = sorted((order["trigger"], order["entry_cap"]))
            action = "short" if order["direction"] == "short" else "buy"
            event(logger, f"paper.{action}_queued", "A simulated entry is waiting for the next prices", date=day,
                  symbol=order["asset"]["symbol"], strategy=order["strategy"], shares=order["quantity"],
                  direction=order["direction"], minimum_price=lower, maximum_price=upper)
        for captured in skipped:
            action = "short" if captured["strategy"] == SHORT_STRATEGY else "buy"
            event(logger, f"paper.{action}_skipped", "A simulated entry was skipped", date=day, **captured)
        if book["closed"]:
            summary = _summary(book)
            event(logger, "paper.day_closed", "Paper trading day closed", date=day, sells=summary["sells"],
                  realized=summary["realized"], open=summary["open"])
        return {order["asset"]["symbol"] for order in book["orders"]}

    def view(self, day):
        with self.guard:
            state = self._load()
            book = state["books"].get(day)
            history = [_summary(state["books"][key]) for key in sorted(state["books"], reverse=True)[:30]]
            closed_results = [Decimal(order["net"]) for saved in state["books"].values()
                              for order in saved["orders"] if "net" in order]
            overview = {"trial": state["trial"], "history": history, "totals": {
                "days": len(state["books"]), "trades": len(closed_results),
                "wins": sum(result > 0 for result in closed_results),
                "realized": str(sum(closed_results, ZERO)),
            }}
            if not book:
                return {**overview, "session": None}
            fills = sorted(book["orders"], key=lambda item: item["at"], reverse=True)
            counts = Counter(order["strategy"] for order in book["orders"] if "net" in order)
            has_shorts = book.get("allow_shorts") or any(order.get("direction") == "short" for order in fills)
            methods = PAPER_STRATEGIES if has_shorts else STRATEGIES
            realized = {key: str(sum((Decimal(item["net"]) for item in book["orders"]
                                      if "net" in item and item["strategy"] == key), ZERO))
                        for key in methods}
            session = {
                **_summary(book), "orders": fills,
                "holdings": [{**position, "unrealized": str(_open_result(position))} for position in book["positions"].values()],
                "queued": list(book["pending"].values()),
                "activity": [{
                    **scan, "orders": book["orders"][scan["first_fill"]:scan["first_fill"] + scan["fill_count"]],
                } for scan in reversed(book.get("activity", []))],
                "skipped": book["skipped"], "strategies": [
                    {"key": key, "label": label, "trades": counts[key], "net": realized[key]}
                    for key, label in methods.items()
                ],
            }
            return {**overview, "session": session}
