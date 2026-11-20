from dataclasses import asdict
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pytest

from tradingagents.dashboard import daily_desk, daily_research
from tradingagents.dashboard.daily_paper import AutoTradeSettings
from tradingagents.dashboard.daily_strategy import (
    IST,
    RISK_CAP,
    SHORT_STRATEGY,
    Candle,
    cash_costs,
    evaluate,
    position_size,
)
from tradingagents.dataflows.errors import VendorError
from tradingagents.dataflows.vendors import nse

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


def test_missing_security_master_falls_back_to_prior_nse_equities():
    previous = ("2026-11-18", [
        {"TckrSymb": "EXAMPLE", "SctySrs": "EQ", "ClsPric": "100", "ISIN": "INE123456789",
         "FinInstrmNm": "Example company", "TtlTrfVal": "50000"},
        {"TckrSymb": "EXAMPLEETF", "SctySrs": "EQ", "ClsPric": "100", "ISIN": "INF123456789"},
        {"TckrSymb": "EXAMPLEBE", "SctySrs": "BE", "ClsPric": "100", "ISIN": "INE987654321"},
    ])
    candidates = daily_desk._candidates((), previous, {}, {}, [], _when("10:01"), True, paper=True)
    assets = {row["symbol"]: row for row in candidates}
    assert assets["EXAMPLE.NS"]["name"] == "Example company"
    assert assets["EXAMPLE.NS"]["isin"] == "INE123456789"
    assert assets["EXAMPLE.NS"]["prior_close"] == 100
    assert "EXAMPLEETF.NS" not in assets
    assert "EXAMPLEBE.NS" not in assets


def test_paper_capital_prefers_fresh_plans_and_counts_each_stock_once():
    idea = {"symbol": "EXAMPLE.NS", "fresh": True, "status": "watch", "size": {"reward_risk": 2},
            "entry_cap": 100, "stop": 99}
    alternatives = [
        {**idea, "stop": 98},
        {**idea, "symbol": "STALE.NS", "fresh": False},
        {**idea, "symbol": "CLOSED.NS", "status": "target"},
    ]
    estimate = daily_desk._suggested_capital([], [idea, *alternatives], 65)
    assert estimate == {"amount": 200, "risk_bps": 65, "basis": "setups", "sample": 1, "affordable": 1}
    assert daily_desk._suggested_capital([], [idea], 10)["amount"] > estimate["amount"]


def test_premarket_capital_uses_auction_and_saved_risk_without_changing_budget(tmp_path):
    desk = daily_desk.DailyDesk({"results_dir": tmp_path})
    desk.session_day = DAY
    desk.session = _session(DAY)
    desk.paper.configure(AutoTradeSettings(enabled=True, risk_bps=20), _when("09:00"))
    candidate = {"symbol": "EXAMPLE.NS", "preopen_price": 105, "prior_close": 100, "prior_range_fraction": .02}
    desk._save(desk.path(DAY, "scan.json"), {"candidates": [
        candidate, {**candidate, "symbol": "ACTION.NS", "corporate_action": "Split"},
        {"symbol": "MISSING.NS", "prior_close": 100},
    ]})
    desk._save(desk.path(DAY, "budget.json"), {"budget": 7000})
    result = desk.view(now=_when("09:10"))
    assert result["suggested_capital"] == {
        "amount": 1200, "risk_bps": 20, "basis": "prior-range", "sample": 1, "affordable": 1,
    }
    assert result["budget"] == desk.budget(DAY) == 7000
    assert desk.view(now=_when("14:46"))["suggested_capital"] is None


def test_shortlist_uses_active_individual_stock_contracts(monkeypatch):
    content = (
        b"UNDERLYING,SYMBOL,NOV-26,DEC-26\nNIFTY 50,NIFTY,65,65\n"
        b"Derivatives on Individual Securities,Symbol,NOV-26,DEC-26\n"
        b"Example,EXAMPLE,100,100\nUpcoming,UPCOMING,-,100\n"
    )
    with monkeypatch.context() as patches:
        patches.setattr(nse, "_get", lambda _: SimpleNamespace(content=content))
        try:
            assert nse.short_eligible_symbols(DAY) == frozenset({"EXAMPLE"})
        finally:
            nse.short_eligible_symbols.cache_clear()


def test_replay_entry_occurs_after_the_candle_a_scheduled_scan_misses(range_breakout):
    earlier, bars = range_breakout
    missed_open = _candle(4, 104, 104.1, 102.9, 103.1)
    next_open = _candle(5, 103.1, 103.6, 102.9, 103.3)
    assert _range_idea(earlier, [*bars, missed_open, next_open])["status"] == "missed"
    ideas, _ = evaluate(earlier, [*bars, missed_open, next_open], 100, entry_delay_bars=1)
    idea = next(idea for idea in ideas if idea["strategy"] == "opening-range")
    assert idea["entry_at"] == next_open.time
    assert idea["entry"] == next_open.open


def test_breakdown_confirms_short_only_when_enabled(range_breakout):
    def mirror(bar):
        return Candle(bar.time, 200 - bar.open, 200 - bar.low, 200 - bar.high, 200 - bar.close, bar.volume)

    earlier, bars = [[mirror(bar) for bar in group] for group in range_breakout]
    ideas, _ = evaluate(earlier, bars, 100)
    assert all(idea["strategy"] != SHORT_STRATEGY for idea in ideas)
    with_shorts, _ = evaluate(earlier, bars, 100, allow_shorts=True)
    short = next(idea for idea in with_shorts if idea["strategy"] == SHORT_STRATEGY)
    assert short["status"] == "confirmed"
    assert short["target"] < short["entry_cap"] <= short["trigger"] < short["stop"]


@pytest.mark.parametrize("series,queues_short", [("EQ", True), ("BE", False)])
def test_daily_scan_gates_paper_shorts_on_current_cash_series(tmp_path, monkeypatch, range_breakout, series, queues_short):
    observed = _when("09:36")

    class FrozenTime(datetime):
        @classmethod
        def now(cls, tz):
            return observed.astimezone(tz)

    def mirror(bar):
        return asdict(Candle(bar.time, 200 - bar.open, 200 - bar.low, 200 - bar.high, 200 - bar.close, bar.volume))

    earlier, bars = range_breakout
    isin = "INE123456789"
    monkeypatch.setattr(daily_desk, "datetime", FrozenTime)
    monkeypatch.setattr(daily_desk, "DEFAULTS", ())
    monkeypatch.setattr(nse, "securities", lambda *_: ({"SYMBOL": "EXAMPLE", "SERIES": series, "ISIN NUMBER": isin},))
    monkeypatch.setattr(nse, "last_bhavcopy", lambda *_: ("2026-11-18", (
        {"TckrSymb": "EXAMPLE", "SctySrs": "EQ", "ClsPric": "100", "ISIN": isin},
    )))
    monkeypatch.setattr(nse, "short_eligible_symbols", lambda *_: frozenset({"EXAMPLE"}))
    provider = daily_desk.provider
    monkeypatch.setattr(provider, "intraday", lambda *_: ([mirror(bar) for bar in bars], "Reference", "reference"))
    monkeypatch.setattr(provider, "history", lambda *_: [mirror(bar) for bar in earlier])
    monkeypatch.setattr(provider, "active_equities", lambda *_: {})
    monkeypatch.setattr(provider, "market_status", lambda *_: {
        "marketState": [{"market": "Capital Market", "marketStatus": "Open"}],
    })
    monkeypatch.setattr(provider, "disclosures", lambda *_: [])
    monkeypatch.setattr(provider, "corporate_actions", lambda *_: [])
    monkeypatch.setattr(provider, "live_quotes", lambda *_: {})
    desk = daily_desk.DailyDesk({"results_dir": tmp_path})
    desk.session = _session(DAY)
    desk.paper.configure(AutoTradeSettings(enabled=True, allow_shorts=True), _when("09:30"))
    desk._scan(DAY, observed, "09:36", {
        "brief": {"title": "Saved report"}, "ideas": [{"symbol": "EXAMPLE.NS", "status": "open"}],
    })
    session = desk.paper.view(DAY)["session"]
    assert any(order["direction"] == "short" for order in session["queued"]) == queues_short
    saved = desk._read(desk.path(DAY, "scan.json"), {})
    assert all(idea["strategy"] != SHORT_STRATEGY for idea in saved["ideas"])


def test_replay_reports_unusable_opening_volume(monkeypatch):
    rows = [asdict(_candle(index, 100, 101, 99, 100, volume=0 if day == index == 0 else 100, days_ago=day))
            for day in range(7, -1, -1) for index in range(72)]
    monkeypatch.setattr(daily_research.provider, "history", lambda *_: rows)
    result = daily_research.replay_summary([{"symbol": "EXAMPLE.NS"}], "2026-11-20", 5000)
    assert result["sessions"] == 0
    assert result["incomplete_sessions"] == 1


def test_broker_history_requests_non_overlapping_date_ranges(monkeypatch):
    provider = daily_desk.provider
    requested = []
    monkeypatch.setattr(provider, "_upstox_token", lambda: "test-token")

    def fetch(url, *, token):
        assert token == "test-token"
        assert "/v3/historical-candle/NSE_EQ%7CINE123456789/minutes/5/" in url
        last, first = map(date.fromisoformat, url.split("/")[-2:])
        requested.append((first, last))
        return {"data": {"candles": [[f"{first}T09:15:00+05:30", 101, 102, 100, 101, 200]]}}

    monkeypatch.setattr(provider, "_get", fetch)
    try:
        bars = provider.history("EXAMPLE.NS", DAY, "46d", "INE123456789")
        assert len(bars) == len(requested) == 2
        assert requested[0][0] == date.fromisoformat(DAY) - timedelta(days=45)
        assert requested[0][1] + timedelta(days=1) == requested[1][0]
        assert requested[1][1] == date.fromisoformat(DAY)
    finally:
        provider.history.cache_clear()


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
