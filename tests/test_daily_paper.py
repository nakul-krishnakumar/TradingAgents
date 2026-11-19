from datetime import datetime
from decimal import Decimal

from tradingagents.dashboard.daily_desk import _candidates
from tradingagents.dashboard.daily_paper import AutoTradeSettings, DailyPaper
from tradingagents.dashboard.daily_strategy import IST

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

    reload = DailyPaper(path)
    current = {row["symbol"]: chart(candle("09:35"), candle("09:40")) for row in assets}
    reload.advance(when("09:44:59"), "open", 5000, assets, current, [], True)
    assert reload.view(DAY)["session"]["orders"] == []
    reload.advance(when("09:46"), "open", 8000, assets, current, [], True)
    reload.advance(when("09:46"), "open", 8000, assets, current, [], True)

    state = reload.view(DAY)["session"]
    assert state["budget"] == "5000.00"
    assert state["trades"] == 2
    assert state["fills"] == 4
    assert Decimal(state["realized"]) > 0
    buys = [row for row in state["orders"] if row["side"] == "buy"]
    assert all(row["at"] == timestamp("09:40") > row["submitted_at"] for row in buys)
    assert all(row["recorded_at"] == timestamp("09:46") and row["source"] == "Reference candles" for row in buys)
    assert sum(Decimal(str(row["price"])) * row["units"] + Decimal(row["fee"]) for row in buys) <= 5000


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


def test_stopping_preserves_positions_and_their_exit_rules(tmp_path):
    account = DailyPaper(tmp_path / "auto.json")
    assets, signals = assets_and_signals(["AAA.NS"])
    account.configure(AutoTradeSettings(enabled=True), when("09:00"))
    account.advance(when("09:36"), "open", 5000, assets, {}, signals, True)
    entered = chart(candle("09:40", high=100.3, close=100.1))
    account.advance(when("09:46"), "open", 5000, assets, {"AAA.NS": entered}, [], True)

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
