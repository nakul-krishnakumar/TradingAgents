import json
from datetime import datetime
from decimal import Decimal

import pytest

from tradingagents.dashboard.daily_desk import _candidates
from tradingagents.dashboard.daily_paper import AutoTradeSettings, DailyPaper
from tradingagents.dashboard.daily_strategy import IST, SHORT_STRATEGY

DAY = "2026-11-19"


def when(clock, day=DAY):
    return datetime.fromisoformat(f"{day}T{clock}").replace(tzinfo=IST)


def timestamp(clock, day=DAY):
    return int(when(clock, day).timestamp())


def assets_and_signals(symbols, signal_at="09:35"):
    assets = [{"symbol": symbol, "name": symbol, "isin": None} for symbol in symbols]
    signals = [
        {"symbol": symbol, "status": "confirmed", "strategy": strategy,
         "trigger": 99.8, "entry_cap": 100, "stop": 99.35, "target": 102.5,
         "relative_volume": 2, "size": {"reward_risk": 2}, "confirmation_at": timestamp(signal_at)}
        for symbol, strategy in zip(symbols, ("opening-range", "vwap-reclaim", "gap-continuation"), strict=False)
    ]
    return assets, signals


def candle(clock, *, opening=99.9, high=102.9, low=99.65, close=102.5):
    return {"time": timestamp(clock), "open": opening, "high": high, "low": low, "close": close, "volume": 500}


def chart(*bars):
    return {"bars": list(bars), "source": "Reference candles"}


def test_automatic_fills_are_forward_only_and_share_cash(tmp_path):
    path = tmp_path / "auto.json"
    account = DailyPaper(path)
    assets, signals = assets_and_signals(["AAA.NS", "BBB.NS", "CCC.NS"])
    account.configure(AutoTradeSettings(enabled=True), when("09:00"))
    previous = {row["symbol"]: chart(candle("09:30"), candle("09:35")) for row in assets}
    account.advance(when("09:36"), "open", 5000, assets, previous, signals, True)
    state = account.view(DAY)["session"]
    assert state["orders"] == []
    assert [row["asset"]["symbol"] for row in state["queued"]] == ["AAA.NS", "BBB.NS"]
    assert sum(Decimal(row["reserved"]) for row in state["queued"]) <= 5000
    checked = state["activity"][0]
    assert checked["number"] == 1
    assert checked["at"] == timestamp("09:36")
    assert checked["mode"] == "checking-buys"
    assert checked["signals"] == 3
    assert [row["symbol"] for row in checked["checked"]] == ["AAA.NS", "BBB.NS", "CCC.NS"]
    assert checked["skipped"] == [{"symbol": "CCC.NS", "strategy": "gap-continuation", "reason": "Cash or risk limit"}]
    assert [row["asset"]["symbol"] for row in checked["queued"]] == ["AAA.NS", "BBB.NS"]
    assert not checked["orders"]

    reload = DailyPaper(path)
    current = {row["symbol"]: chart(candle("09:35"), candle("09:40")) for row in assets}
    reload.advance(when("09:44:59"), "open", 5000, assets, current, [], True)
    assert reload.view(DAY)["session"]["orders"] == []
    reload.advance(when("09:46"), "open", 8000, assets, current, [], True)
    reload.advance(when("09:46"), "open", 8000, assets, current, [], True)

    result = DailyPaper(path).view(DAY)
    state = result["session"]
    assert state["budget"] == "5000.00"
    assert state["trades"] == 2
    assert state["fills"] == 4
    assert Decimal(state["realized"]) > 0
    buys = [row for row in state["orders"] if row["side"] == "buy"]
    assert all(row["at"] == timestamp("09:40") > row["submitted_at"] for row in buys)
    assert all(row["recorded_at"] == timestamp("09:46") and row["source"] == "Reference candles" for row in buys)
    assert sum(Decimal(str(row["price"])) * row["units"] + Decimal(row["fee"]) for row in buys) <= 5000
    assert state["buys"] == state["sells"] == 2
    assert state["total_result"] == state["realized"]
    assert result["totals"] == {"days": 1, "trades": 2, "wins": 2, "realized": state["realized"]}
    repeat, filled, waiting, planned = state["activity"]
    assert repeat["at"] == filled["at"]
    assert [row["side"] for row in filled["orders"]] == ["buy", "sell", "buy", "sell"]
    assert all(row["bar_at"] == timestamp("09:40") for row in filled["orders"])
    assert [row["asset"]["symbol"] for row in planned["queued"]] == ["AAA.NS", "BBB.NS"]
    assert waiting["waiting"] == 2
    assert not (repeat["orders"] or waiting["orders"] or planned["orders"])


def test_enabling_mid_session_excludes_earlier_signals_and_skips_overshoots(tmp_path):
    account = DailyPaper(tmp_path / "auto.json")
    assets, old_signals = assets_and_signals(["AAA.NS"])
    account.configure(AutoTradeSettings(enabled=True), when("09:35:30"))
    account.advance(when("09:36"), "open", 5000, assets, {}, old_signals, True)
    assert account.view(DAY)["session"]["pending"] == 0

    _, signals = assets_and_signals(["AAA.NS"], signal_at="09:40")
    account.advance(when("09:41"), "open", 5000, assets, {}, signals, True)
    account.advance(when("09:51"), "open", 5000, assets,
                    {"AAA.NS": chart(candle("09:45", opening=100.2))}, [], True)
    session = account.view(DAY)["session"]
    assert session["orders"] == []
    assert session["skipped"] == {"Opening price outside entry range": 1}
    assert session["activity"][0]["skipped"] == [
        {"symbol": "AAA.NS", "strategy": "opening-range", "reason": "Opening price outside entry range",
         "opening_price": 100.2, "minimum_price": 99.8, "maximum_price": 100, "entry_at": timestamp("09:45")}
    ]
    assert session["activity"][-1]["signals"] == 0


def short_signal(eligible=True):
    assets, signals = assets_and_signals(["AAA.NS"])
    assets[0]["short_eligible"] = eligible
    signals[0].update(strategy=SHORT_STRATEGY, trigger=100, entry_cap=99.8, stop=100.6, target=97.5)
    return assets, signals


@pytest.mark.parametrize("enabled,eligible", [(False, True), (True, False)])
def test_short_requires_trial_setting_and_eligibility(tmp_path, enabled, eligible):
    account = DailyPaper(tmp_path / "auto.json")
    assets, signals = short_signal(eligible)
    account.configure(AutoTradeSettings(enabled=True, allow_shorts=enabled), when("09:00"))
    account.advance(when("09:36"), "open", 5000, assets, {}, signals, True)
    assert account.view(DAY)["session"]["queued"] == []


@pytest.mark.parametrize("opening_price,high,reason,cover_price", [
    (100.8, 101, "stop", 100.8),
    (99.8, 100.2, "target", 97.5),
])
def test_short_is_collateralized_and_can_cover_after_pausing(tmp_path, opening_price, high, reason, cover_price):
    path = tmp_path / "auto.json"
    account = DailyPaper(path)
    assets, signals = short_signal()
    account.configure(AutoTradeSettings(enabled=True, allow_shorts=True, risk_bps=30), when("09:00"))
    account.configure(AutoTradeSettings(enabled=True), when("09:01"))
    account.advance(when("09:36"), "open", 5000, assets, {}, signals, True)
    queued = account.view(DAY)["session"]["queued"][0]
    assert (queued["direction"], queued["risk_bps"], queued["enter_at"]) == ("short", 30, timestamp("09:40"))
    assert queued["quantity"] < 25
    assert Decimal(queued["reserved"]) > Decimal(queued["quantity"]) * 100

    opening = candle("09:40", opening=99.9, high=100.2, low=99.5, close=99.6)
    account.advance(when("09:46"), "open", 5000, assets, {"AAA.NS": chart(opening)}, [], True)
    state = account.view(DAY)["session"]
    assert (state["open"], state["buys"], state["sells"], state["trades"]) == (1, 0, 1, 0)
    assert Decimal(state["cash"]) + Decimal(state["invested"]) == 5000
    assert "net" not in state["orders"][0]

    account.configure(AutoTradeSettings(enabled=False), when("09:47"))
    account = DailyPaper(path)
    following = candle("09:45", opening=opening_price, high=high, low=97, close=99)
    account.advance(when("09:51"), "open", 5000, assets, {"AAA.NS": chart(opening, following)}, [], False)
    results = account.view(DAY)
    state = results["session"]
    cover, entry = state["orders"]
    assert (cover["side"], cover["reason"], cover["price"]) == ("buy", reason, cover_price)
    assert (state["open"], state["buys"], state["sells"], state["trades"]) == (0, 1, 1, 1)
    expected = (Decimal("99.9") - Decimal(str(cover_price))) * entry["units"]
    expected -= Decimal(entry["fee"]) + Decimal(cover["fee"])
    assert Decimal(state["realized"]) == Decimal(cover["net"]) == expected
    assert Decimal(state["cash"]) == 5000 + expected
    assert results["totals"]["trades"] == 1


def test_short_with_a_missing_interval_stays_unresolved(tmp_path):
    account = DailyPaper(tmp_path / "auto.json")
    assets, signals = short_signal()
    account.configure(AutoTradeSettings(enabled=True, allow_shorts=True), when("09:00"))
    account.advance(when("09:36"), "open", 5000, assets, {}, signals, True)
    opening = candle("09:40", opening=99.9, high=100.2, low=99.5, close=99.6)
    after_gap = candle("09:50", opening=97, high=97.1, low=96.8, close=97)
    account.advance(when("09:46"), "open", 5000, assets, {"AAA.NS": chart(opening)}, [], True)
    account.advance(when("15:31"), "after-hours", 5000, assets, {"AAA.NS": chart(opening, after_gap)}, [], False)
    state = account.view(DAY)["session"]
    assert (state["sells"], state["buys"], state["unresolved"], state["trades"]) == (1, 0, 1, 0)
    assert state["holdings"][0]["data_gap"]


def test_risk_slider_sizes_the_same_long_signal(tmp_path):
    assets, signals = assets_and_signals(["AAA.NS"])
    quantities = []
    for bps in (10, 65):
        account = DailyPaper(tmp_path / f"auto-{bps}.json")
        account.configure(AutoTradeSettings(enabled=True, risk_bps=bps), when("09:00"))
        account.advance(when("09:36"), "open", 5000, assets, {}, signals, True)
        state = account.view(DAY)["session"]
        assert state["activity"][0]["signals"] == 1
        quantities.append(state["queued"][0]["quantity"])
    assert 0 < quantities[0] < quantities[1]


def test_stopping_preserves_positions_and_their_exit_rules(tmp_path):
    account = DailyPaper(tmp_path / "auto.json")
    assets, signals = assets_and_signals(["AAA.NS"])
    account.configure(AutoTradeSettings(enabled=True), when("09:00"))
    account.advance(when("09:36"), "open", 5000, assets, {}, signals, True)
    entered = chart(candle("09:40", high=100.3, close=100.1))
    account.advance(when("09:46"), "open", 5000, assets, {"AAA.NS": entered}, [], True)
    open_session = account.view(DAY)["session"]
    assert open_session["buys"] == 1 and open_session["sells"] == 0
    assert Decimal(open_session["realized"]) == 0
    assert open_session["total_result"] == open_session["unrealized"] == open_session["holdings"][0]["unrealized"]

    account.configure(AutoTradeSettings(enabled=False), when("09:47"))
    active, tracking, _ = account.inputs(DAY, when("09:48").time())
    assert not active and "AAA.NS" in tracking
    down = candle("09:45", opening=98.9, high=100, low=97.9, close=99.1)
    account.advance(when("09:51"), "open", 5000, assets, {"AAA.NS": chart(down)}, [], True)
    session = account.view(DAY)["session"]
    assert session["orders"][0]["side"] == "sell"
    assert session["orders"][0]["price"] == 98.9
    assert session["orders"][0]["reason"] == "stop"
    assert Decimal(session["realized"]) < 0
    assert session["activity"][0]["mode"] == "buys-paused"
    assert session["activity"][0]["orders"] == [session["orders"][0]]


def test_trial_counts_regular_sessions_and_leaves_missing_exits_visible(tmp_path):
    account = DailyPaper(tmp_path / "auto.json")
    assets, signals = assets_and_signals(["AAA.NS"])
    account.configure(AutoTradeSettings(enabled=True, sessions=1), when("17:00", "2026-11-18"))
    account.advance(when("18:00", "2026-11-18"), "after-hours", 5000, [], {}, [], False)
    assert not account.view(DAY)["history"]

    account.advance(when("09:36"), "open", 5000, assets, {}, signals, True)
    entered = chart(candle("09:40", high=100.3, close=100.1))
    account.advance(when("09:46"), "open", 5000, assets, {"AAA.NS": entered}, [], True)
    account.advance(when("15:31"), "after-hours", 5000, assets, {}, [], False)
    result = account.view(DAY)
    assert result["session"]["unresolved"] == 1
    assert result["session"]["closed"]
    assert result["trial"]["ended_by"] == "completed"
    assert not result["trial"]["enabled"]
    account.advance(when("09:21", "2026-11-20"), "open", 5000, [], {}, [], True)
    assert [item["day"] for item in account.view(DAY)["history"]] == [DAY]


def test_earlier_days_keep_trades_without_detailed_checks(tmp_path):
    path = tmp_path / "auto.json"
    account = DailyPaper(path)
    assets, signals = assets_and_signals(["AAA.NS"])
    account.configure(AutoTradeSettings(enabled=True), when("09:00"))
    account.advance(when("09:36"), "open", 5000, assets, {}, signals, True)
    account.advance(when("09:46"), "open", 5000, assets, {"AAA.NS": chart(candle("09:40"))}, [], True)
    prior = account.view(DAY)
    stored = json.loads(path.read_text())
    del stored["books"][DAY]["activity"]
    for order in stored["books"][DAY]["orders"]:
        order.pop("bar_at")
        order.pop("signal_reason")
    path.write_text(json.dumps(stored))

    result = account.view(DAY)
    assert result["session"]["activity"] == []
    assert result["session"]["fills"] == 2
    assert result["totals"] == prior["totals"]
    account.advance(when("09:51"), "open", 5000, assets, {}, [], True)
    result = account.view(DAY)
    assert result["session"]["activity"][0]["number"] == 3
    assert result["session"]["activity"][0]["orders"] == []
    assert result["totals"] == prior["totals"]


def test_paper_scans_rotate_beyond_watchlist_and_keep_open_symbols():
    master = [{"SYMBOL": f"ASSET{i}", "SERIES": "EQ"} for i in range(100)]
    previous = ("2026-11-18", [
        {"TckrSymb": f"ASSET{i}", "SctySrs": "EQ", "ClsPric": "40", "TtlTrfVal": 1000 - i}
        for i in range(100)
    ])
    tracked = {"HELD.NS": {"name": "Still held", "isin": "INE123456789"}}
    first = _candidates(master, previous, {}, {}, [], when("09:36"), True, paper=True, tracked=tracked)
    second = _candidates(master, previous, {}, {}, [], when("09:41"), True, paper=True, tracked=tracked)
    assert first[0]["symbol"] == second[0]["symbol"] == "HELD.NS"
    assert first[0]["isin"] == tracked["HELD.NS"]["isin"]
    assert any(row["prior_close"] == 40 for row in first)
    assert {row["symbol"] for row in first} != {row["symbol"] for row in second}
