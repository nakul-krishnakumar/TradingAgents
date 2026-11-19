"""Deterministic cash-equity setups for the daily desk."""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, time
from statistics import median
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
OPEN = time(9, 15)
CLOSE = time(15, 30)
ENTRY_CUTOFF = time(14, 45)
EXIT_CUTOFF = time(15, 0)
LAST_CONTINUOUS_BAR = time(15, 15)
BAR_SECONDS = 300
RISK_CAP = 0.0065
SLIPPAGE = 0.0008
STRATEGIES = {
    "opening-range": "Opening range breakout",
    "vwap-reclaim": "VWAP reclaim",
    "gap-continuation": "Gap continuation",
}
CLOSED_STATES = {"stop", "target", "time-exit"}


@dataclass(frozen=True)
class Candle:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float

    @property
    def local(self):
        return datetime.fromtimestamp(self.time, IST)


def leg_cost(side, amount):
    brokerage = min(20, amount * 0.0003)
    exchange_sebi = amount * (0.0000307 + 0.000001)
    statutory = amount * (0.00003 if side == "buy" else 0.00025)
    return (brokerage + exchange_sebi) * 1.18 + statutory + amount * SLIPPAGE


def cash_costs(entry, exit_price, quantity):
    return leg_cost("buy", entry * quantity) + leg_cost("sell", exit_price * quantity)


def long_exit(bar, stop, target):
    if bar.local.time() >= EXIT_CUTOFF:
        return bar.open, "time-exit", bar.time
    if bar.open >= target:
        return target, "target", bar.time
    if bar.low <= stop:
        return min(stop, bar.open), "stop", bar.time if bar.open <= stop else bar.time + BAR_SECONDS
    if bar.high >= target:
        return target, "target", bar.time + BAR_SECONDS
    return None


def position_size(entry, stop, target, budget):
    if not 0 < stop < entry < target:
        return None
    loss_one = entry - stop + cash_costs(entry, stop, 1)
    reward_one = target - entry - cash_costs(entry, target, 1)
    quantity = math.floor(min(budget / (entry * 1.002), budget * RISK_CAP / loss_one))
    loss = (entry - stop) * quantity + cash_costs(entry, stop, quantity)
    spend = entry * quantity
    return {
        "quantity": quantity,
        "capital": round(spend, 2),
        "estimated_loss": round(loss, 2),
        "budget_risk_pct": round(loss / budget * 100, 3) if budget else 0,
        "stop_distance_pct": round((entry - stop) / entry * 100, 2),
        "reward_risk": round(reward_one / loss_one, 2),
        "estimated_round_trip": round(cash_costs(entry, stop, quantity), 2),
    }


def indicators(previous, today):
    baselines = defaultdict(list)
    for bar in previous:
        if bar.volume > 0:
            baselines[bar.local.time()].append(bar.volume)
    total_value = total_volume = 0.0
    result = []
    for bar in today:
        total_volume += bar.volume
        total_value += (bar.high + bar.low + bar.close) / 3 * bar.volume
        baseline = baselines[bar.local.time()]
        result.append({
            "vwap": total_value / total_volume if total_volume else bar.close,
            "rvol": bar.volume / median(baseline) if len(baseline) >= 5 else None,
        })
    return result


def _setup(kind, trigger, stop, bar, feature, reason, gap):
    # A minimum price buffer keeps rounding from making the levels equal.
    trigger, stop = round(trigger, 2), round(stop, 2)
    if trigger <= 0 or stop <= 0 or trigger - stop < max(0.02, trigger * 0.001):
        return None
    max_entry = round(trigger + min((trigger - stop) * 0.18, trigger * 0.002), 2)
    target = round(max_entry + (max_entry - stop) * 2.4, 2)
    stop_pct = (max_entry - stop) / max_entry * 100
    tier = "Low" if stop_pct < 0.4 else "Medium" if stop_pct < 0.75 else "High" if stop_pct < 1.2 else "Very high"
    return {
        "strategy": kind, "label": STRATEGIES[kind], "status": "watch",
        "trigger": trigger, "entry_cap": max_entry, "stop": stop, "target": target,
        "risk": tier, "relative_volume": round(feature["rvol"], 2) if feature["rvol"] is not None else None,
        "vwap": round(feature["vwap"], 2), "gap_pct": round(gap, 2) if gap is not None else None,
        "observed_at": bar.time + BAR_SECONDS, "reason": reason,
    }


def _advance(idea, bar, active_at):
    start = bar.local.time()
    if idea["status"] == "confirmed":
        if bar.time != idea["confirmation_at"]:
            idea.update(status="missed", exit_at=bar.time, exit_reason="The next five-minute candle was unavailable.")
            return
        if start >= ENTRY_CUTOFF or bar.open < idea["trigger"] or bar.open > idea["entry_cap"]:
            idea.update(status="missed", exit_at=bar.time, exit_reason="The next opening price was outside the entry range.")
            return
        idea.update(status="open", entry=round(bar.open, 2), entry_at=bar.time)
    if idea["status"] != "open":
        return
    outcome = long_exit(bar, idea["stop"], idea["target"])
    if not outcome:
        return
    price, status, _ = outcome
    reason = {
        "time-exit": "The strategy's intraday exit cutoff was reached.",
        "target": "Price reached the planned target.",
        "stop": "Price touched or opened below the stop.",
    }[status]
    if bar.open >= idea["target"] and status == "target":
        reason = "The candle opened beyond the target. The model used the target price."
    idea.update(status=status, exit_price=round(price, 2), exit_at=bar.time if start >= EXIT_CUTOFF else active_at,
                exit_reason=reason)


def evaluate(previous, bars, prior_close, budget=5000):
    """Replay available bars in order. The confirmation close cannot be the fill."""
    if len(bars) < 3:
        return [], indicators(previous, bars)
    features = indicators(previous, bars)
    opening = bars[:3]
    first = opening[0].local.replace(hour=9, minute=15, second=0, microsecond=0)
    if any(bar.time != int(first.timestamp()) + index * BAR_SECONDS for index, bar in enumerate(opening)):
        return [], features
    opening_high = max(bar.high for bar in opening)
    opening_low = min(bar.low for bar in opening)
    session_low = opening_low
    gap = (opening[0].open / prior_close - 1) * 100 if prior_close and prior_close > 0 else None
    ideas = {}
    for index, bar in enumerate(bars[2:], 2):
        feature = features[index]
        vwap, rvol = feature["vwap"], feature["rvol"]
        complete_at = bar.time + BAR_SECONDS
        session_low = min(session_low, bar.low)
        for idea in ideas.values():
            if idea["status"] == "open" and bar.time != bars[index - 1].time + BAR_SECONDS:
                idea.update(status="data-gap", exit_reason="A candle was missing while the simulated trade was open.")
            _advance(idea, bar, complete_at)
        if (index == 2 or bar.time != bars[index - 1].time + BAR_SECONDS
                or datetime.fromtimestamp(complete_at, IST).time() >= ENTRY_CUTOFF):
            continue

        prior = bars[index - 1]
        former = features[index - 1]["vwap"]
        pullback = min(bar.low, prior.low, bars[index - 2].low)
        near_opening = bar.close >= opening_high * 0.992 and bar.close >= vwap
        strong_opening = bar.close > opening_high and prior.close <= opening_high and bar.close > vwap
        reclaim = prior.close <= former and bar.close > vwap and vwap >= former and bar.close >= opening[0].open
        candidates = (
            ("opening-range", opening_high, max(opening_low, min(vwap, opening_high * 0.996)),
             near_opening, strong_opening, 1.5, "Watch for a close above the first 15-minute high and session VWAP.",
             "A completed candle closed above the first 15-minute high and session VWAP with elevated volume."),
            ("vwap-reclaim", vwap, pullback, bar.close >= vwap * 0.996, reclaim, 1.2,
             "Watch for price to reclaim a flat or rising VWAP after a pullback.",
             "A completed candle reclaimed a flat or rising VWAP with elevated volume."),
            ("gap-continuation", max(opening_high, prior_close or 0), max(opening_low, prior_close or 0),
             near_opening and gap is not None and 0.8 <= gap <= 3 and session_low > prior_close,
             strong_opening, 1.5, "Watch for the positive opening gap to hold through a break of the opening range.",
             "The opening gap held and a completed candle cleared the opening range on elevated volume."),
        )
        for kind, trigger, stop, watch, crossed, min_volume, watch_reason, confirmed_reason in candidates:
            existing = ideas.get(kind)
            if existing and existing["status"] != "watch":
                continue
            if not watch:
                ideas.pop(kind, None)
                continue
            if crossed and rvol is not None and rvol >= min_volume:
                trigger = max(trigger, bar.close)
            idea = _setup(kind, trigger, stop, bar, feature, watch_reason, gap)
            if idea is None:
                continue
            sized = position_size(idea["entry_cap"], idea["stop"], idea["target"], budget)
            if (crossed and rvol is not None and rvol >= min_volume and sized
                    and sized["quantity"] > 0 and sized["reward_risk"] >= 1.5):
                idea.update(status="confirmed", confirmation_at=complete_at, reason=confirmed_reason)
            ideas[kind] = idea

    for idea in ideas.values():
        if idea["status"] == "watch" and bars[-1].local.time() >= ENTRY_CUTOFF:
            idea["status"] = "expired"
        if idea.get("entry"):
            idea["size"] = position_size(idea["entry"], idea["stop"], idea["target"], budget)
        else:
            idea["size"] = position_size(idea["entry_cap"], idea["stop"], idea["target"], budget)
    return list(ideas.values()), features
