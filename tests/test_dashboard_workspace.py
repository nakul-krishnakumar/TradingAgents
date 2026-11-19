from decimal import Decimal

import pytest

from tradingagents.dashboard import screener, trends
from tradingagents.dashboard.workspace_store import Asset, PaperOrder, WorkspaceStore


def test_paper_fills_are_atomic_idempotent_and_track_fees(tmp_path):
    store = WorkspaceStore(tmp_path / "workspace.sqlite3")
    basket = store.create("basket", "Test basket", {"capital": "1000", "targets": [], "orders": []})["id"]
    stock = Asset(symbol="INFY.NS")
    buy = PaperOrder(request_id="original-buy-01", asset=stock, side="buy", units=2, fee=2)
    sell = PaperOrder(request_id="original-sell-01", asset=stock, side="sell", units=1, fee=1)
    overdraw = PaperOrder(request_id="excess-buy-01", asset=stock, side="buy", units=50)

    with pytest.raises(ValueError, match="insufficient paper cash"):
        store.fill_batch(basket, [(buy, Decimal(100), "Manual", None), (overdraw, Decimal(100), "Manual", None)])
    assert store.basket(basket)["orders"] == []

    store.fill(basket, buy, Decimal(100), "Manual", None)
    store.fill(basket, buy, Decimal(100), "Manual", None)
    result = store.fill(basket, sell, Decimal(120), "Manual", None)
    assert Decimal(result["cash"]) == 917
    assert Decimal(result["realized"]) == 18
    assert Decimal(result["positions"][0]["cost"]) == 101
    assert len(result["orders"]) == 2

    oversell = PaperOrder(request_id="excess-sell-01", asset=stock, side="sell", units=2)
    with pytest.raises(ValueError, match="does not hold"):
        store.fill(basket, oversell, Decimal(120), "Manual", None)
    assert store.basket(basket) == result


def test_wishlist_membership_and_votes_do_not_duplicate(tmp_path):
    store = WorkspaceStore(tmp_path / "workspace.sqlite3")
    name = store.create("wishlist", "Income", {"assets": []})["id"]
    fund = Asset(symbol="AMFI-122639", kind="fund")
    bond = Asset(symbol="BOND-IN0020260033", kind="bond")
    store.set_wishlist(name, fund, True)
    store.set_wishlist(name, bond, True)
    assert len(store.set_wishlist(name, fund, True)["assets"]) == 2
    assert store.set_wishlist(name, bond, False)["assets"] == [fund.stored()]

    day = "2026-11-19"
    store.vote(fund.symbol, "example-browser", "bullish", day)
    store.vote(fund.symbol, "example-browser", "bearish", day)
    assert store.votes(day)[fund.symbol] == {"bullish": 0, "neutral": 0, "bearish": 1, "total": 1}
    assert store.votes("2026-11-20") == {}


def test_screen_preserves_missing_data_and_includes_exact_zero(tmp_path, monkeypatch):
    funds = [
        {"symbol": f"AMFI-{index}", "kind": "fund", "name": name, "metrics": metrics, "category": "Equity"}
        for index, name, metrics in ((111111, "Zero", {"expense": 0}), (222222, "Unknown", {}),
                                     (333333, "Positive", {"expense": 0.75}))
    ]
    monkeypatch.setattr(screener, "latest_snapshot", lambda *_: {"rows": funds, "session": "", "unavailable": []})
    request = screener.ScreenRequest(kind="fund", sort="expense", descending=False)
    config = {"data_cache_dir": tmp_path}
    result = screener.screen(request, "2026-11-19", config)
    assert [row["name"] for row in result["rows"]] == ["Zero", "Positive", "Unknown"]
    request.filters = [screener.Bounds(key="expense", maximum=0)]
    result = screener.screen(request, "2026-11-19", config)
    assert [row["name"] for row in result["rows"]] == ["Zero"]
    assert result["coverage"]["expense"] == 2


def test_fund_trends_use_a_broad_nav_release(monkeypatch):
    latest, earlier = "2026-11-19", "2026-11-18"
    funds = tuple({"code": code, "name": code, "plan": "Direct Plan", "option": "Growth Option",
                   "date": stamp, "nav": 120.0}
                  for code, stamp in (("100001", latest), ("100002", earlier), ("100003", earlier), ("100004", earlier)))
    monkeypatch.setattr(trends, "fund_directory", lambda *_: funds)
    monkeypatch.setattr(trends, "latest_previous_navs", lambda cutoff: {
        item["code"]: (cutoff, 100.0) for item in funds
    })
    result = trends.fund_movers.__wrapped__(latest, 0)
    assert result["session"] == earlier
    assert result["matched"] == 3
    assert result["rows"][0]["change"] == pytest.approx(20)
