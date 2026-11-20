from dataclasses import asdict
from datetime import datetime, timedelta

import pytest

from tradingagents.dashboard import daily_desk
from tradingagents.dashboard.daily_strategy import (
    IST,
    RISK_CAP,
    Candle,
    cash_costs,
    evaluate,
    position_size,
)
from tradingagents.dataflows.errors import VendorError

DAY = "2026-11-19"


def _when(clock, day=DAY):
    return datetime.fromisoformat(f"{day}T{clock}").replace(tzinfo=IST)


def _session(day):
    if day not in {DAY, "2026-11-23"}:
        return {"verified": True, "opens": None, "closes": None, "note": "Closed"}
    return {
        "verified": True,
        "opens": int(_when("09:15", day).timestamp()),
        "closes": int(_when("15:30", day).timestamp()),
        "note": "Regular session",
    }


def _candle(index, opening, high, low, closing, volume=100, days_ago=0):
    stamp = _when("09:15") + timedelta(minutes=5 * index, days=-days_ago)
    return Candle(int(stamp.timestamp()), opening, high, low, closing, volume)


@pytest.fixture
def range_breakout():
    earlier = [_candle(3, 99, 101, 98, 100, days_ago=day) for day in range(1, 7)]
    bars = [
        _candle(0, 100, 101, 98, 99),
        _candle(1, 99, 100, 97, 99.5),
        _candle(2, 99.5, 100.5, 99, 100),
        _candle(3, 100, 103.5, 99.5, 103, volume=200),
    ]
    return earlier, bars


def _range_idea(earlier, bars, budget=5000):
    ideas, _ = evaluate(earlier, bars, prior_close=100, budget=budget)
    return next(idea for idea in ideas if idea["strategy"] == "opening-range")


def test_regular_session_schedules_premarket_then_completed_bar_scans(tmp_path, monkeypatch):
    monkeypatch.delenv("TRADINGAGENTS_DAILY_ENABLED", raising=False)
    monkeypatch.setattr(daily_desk.provider, "session_for", _session)
    desk = daily_desk.DailyDesk({"results_dir": tmp_path})
    slots = []

    def fake_scan(day, now, slot, current):
        assert desk.view(now=now)["operation"] == "scan"
        slots.append((day, slot))
        desk._save(desk.path(day, "scan.json"), {"slot": slot})

    monkeypatch.setattr(desk, "_scan", fake_scan)
    for clock in ("08:59:59", "09:00", "09:07", "09:20:59", "09:21", "09:26", "09:27", "15:31", "15:49"):
        desk.tick(_when(clock))

    assert slots == [(DAY, "premarket"), (DAY, "09:21"), (DAY, "09:26"), (DAY, "15:31")]
    assert desk.view(now=_when("15:49"))["operation"] is None
    assert desk.view(now=_when("15:49"))["next_scan"] == _when("09:00", "2026-11-23").isoformat()
    holiday = _when("10:00", "2026-11-20")
    desk.tick(holiday)
    assert desk.view(now=holiday)["phase"] == "closed"
    assert len(slots) == 4


def test_scan_only_uses_completed_candles_in_the_requested_session(range_breakout):
    earlier, bars = range_breakout
    raw = [asdict(bar) for bar in [*earlier, *bars]]
    almost = int(_when("09:34:59").timestamp())
    complete = int(_when("09:35").timestamp())

    seen = daily_desk._day_bars(raw, DAY, almost)
    assert seen == bars[:3]
    assert evaluate(earlier, seen, prior_close=100)[0] == []
    assert evaluate(earlier, daily_desk._day_bars(raw, DAY, complete), prior_close=100)[0]


def test_opening_range_fills_on_next_candle_and_prioritizes_stop_when_both_levels_touch(range_breakout):
    earlier, bars = range_breakout
    idea = _range_idea(earlier, bars)
    assert idea["status"] == "confirmed"
    assert "entry" not in idea
    assert _range_idea(earlier[:3], bars)["status"] == "watch"

    following = _candle(4, 103.2, 116, 96, 106)
    filled = _range_idea(earlier, [*bars, following])
    assert filled["entry"] == following.open
    assert filled["entry_at"] == following.time
    assert filled["status"] == "stop"
    assert filled["exit_price"] == filled["stop"]


def test_opening_range_skips_overshoot_and_invalidates_missing_candles(range_breakout):
    earlier, bars = range_breakout
    overshoot = _candle(4, 104.1, 116, 96, 106)
    enters = _candle(4, 103.2, 104.1, 102.9, 103.5)
    later = _candle(6, 103.4, 103.8, 103, 103.7)
    missed = _range_idea(earlier, [*bars, overshoot])
    assert missed["status"] == "missed"
    assert "entry_at" not in missed
    assert _range_idea(earlier, [*bars, later])["status"] == "missed"
    incomplete = _range_idea(earlier, [*bars, enters, later])
    assert incomplete["status"] == "data-gap"
    assert "exit_price" not in incomplete


def test_whole_share_sizing_accounts_for_both_cash_and_stop_costs():
    budget = 5000
    sizes = position_size(200, 198, 208, budget)
    quantity = sizes["quantity"]
    saved_loss = (200 - 198) * quantity + cash_costs(200, 198, quantity)
    assert 0 < quantity < budget // 200
    assert sizes["capital"] == quantity * 200
    assert sizes["estimated_loss"] == pytest.approx(saved_loss, abs=0.005)
    assert 0 < sizes["budget_risk_pct"] <= RISK_CAP * 100
    assert saved_loss <= budget * RISK_CAP < 2 * (quantity + 1) + cash_costs(200, 198, quantity + 1)
    assert position_size(5000, 4999, 5025, budget)["quantity"] == 0
    assert position_size(200, 198, 208, 0)["quantity"] == 0


def test_entry_indication_needs_a_fresh_quote_at_the_right_size_range_and_spread(range_breakout):
    earlier, bars = range_breakout
    idea = _range_idea(earlier, bars)
    size = idea["size"]
    now = _when("09:36")
    stamp = int(now.timestamp())
    book = {"ask": 103.15, "bid": 103.08, "ask_quantity": size["quantity"],
            "at": stamp - 3, "last_trade_at": stamp - 8}

    assert daily_desk._within_entry(idea, size, book, now)
    for overrides in (
        {"at": stamp - 61}, {"last_trade_at": stamp - 91}, {"ask": idea["entry_cap"] + 0.1},
        {"bid": 102.8}, {"ask_quantity": size["quantity"] - 1},
    ):
        assert not daily_desk._within_entry(idea, size, {**book, **overrides}, now)
    assert not daily_desk._within_entry({**idea, "status": "watch"}, size, book, now)
    assert not daily_desk._within_entry(idea, size, book, _when("09:40"))


def test_verified_candles_keep_their_chart_when_prior_volume_history_is_unavailable(range_breakout, monkeypatch):
    _, bars = range_breakout

    def missing_history(*_args):
        raise VendorError("no prior candles")

    monkeypatch.setattr(daily_desk.provider, "history", missing_history)
    monkeypatch.setattr(daily_desk.provider, "intraday", lambda *_: ([asdict(bar) for bar in bars], "Upstox", "reference"))
    asset = {"symbol": "EXAMPLE.NS", "name": "Example", "prior_close": 100}
    result, chart, ideas = daily_desk._scan_asset(asset, DAY, _when("09:36"), True, 5000)
    assert result["last"] == bars[-1].close
    assert result["feed"] == "Upstox"
    assert len(chart) == len(bars)
    assert all(bar["vwap"] > 0 for bar in chart)
    assert {idea["status"] for idea in ideas} == {"watch"}
    assert all(not idea["live"] for idea in ideas)


def test_later_check_keeps_chart_of_traded_stock_after_it_leaves_watchlist(tmp_path, monkeypatch):
    observed = _when("10:01")

    class FrozenTime(datetime):
        @classmethod
        def now(cls, tz):
            return observed.astimezone(tz)

    monkeypatch.setattr(daily_desk, "datetime", FrozenTime)
    monkeypatch.setattr(daily_desk.nse, "securities", lambda *_: ())
    monkeypatch.setattr(daily_desk.nse, "last_bhavcopy", lambda *_: ("", ()))
    for provider in ("active_equities", "market_status", "disclosures", "corporate_actions"):
        monkeypatch.setattr(daily_desk.provider, provider, lambda *_: {})
    monkeypatch.setattr(daily_desk, "_candidates", lambda *_args, **_kwargs: [])
    desk = daily_desk.DailyDesk({"results_dir": tmp_path})
    desk.session = _session(DAY)
    previous = {"bars": [asdict(_candle(5, 100, 101, 99, 100))], "source": "Saved prices"}
    monkeypatch.setattr(desk.paper, "advance", lambda *_: {"TRADED.NS"})
    desk._scan(DAY, observed, "10:01", {
        "brief": {"title": "Saved report"}, "charts": {"TRADED.NS": previous, "OTHER.NS": previous},
    })
    assert desk.chart("TRADED.NS", DAY)["bars"] == previous["bars"]
    assert desk.chart("OTHER.NS", DAY)["bars"] == []


def test_exchange_filings_exclude_future_publication_even_for_an_earlier_quarter():
    release = {
        "symbol": "EXAMPLE", "exchdisstime": "19-Nov-2026 09:16:32", "desc": "September results",
        "attchmntFile": "https://nsearchives.nseindia.in/corporate/example.pdf",
    }
    assets = [{"symbol": "EXAMPLE.NS"}]
    assert daily_desk._evidence([release], assets, _when("09:00")) == []
    current = daily_desk._evidence([release], assets, _when("09:20"))
    assert [item["url"] for item in current] == [release["attchmntFile"]]
    assert current[0]["timestamp"] == _when("09:16:32").isoformat()
