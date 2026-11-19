from types import SimpleNamespace

import pytest

from tradingagents.dashboard.market import chart_data, resolve_symbol, search_funds
from tradingagents.dataflows.vendors import amfi


@pytest.fixture
def uncached_amfi():
    amfi.fund_directory.cache_clear()
    amfi.fund_nav.cache_clear()
    yield
    amfi.fund_directory.cache_clear()
    amfi.fund_nav.cache_clear()


def test_amfi_search_distinguishes_plan_and_option(monkeypatch, uncached_amfi):
    text = (
        "Date;Scheme Name;Plan;Option;Net Asset Value;Scheme Code\n"
        "Open Ended Schemes (Equity)\n"
        "18-Nov-2026;Example Equity Fund;Direct Plan;Growth;32.4;122639\n"
        "18-Nov-2026;Example Equity Fund;Regular Plan;IDCW;30.1;122640\n"
    )
    monkeypatch.setattr(amfi.requests, "get", lambda *a, **kw: SimpleNamespace(
        text=text, raise_for_status=lambda: None,
    ))
    results = search_funds("example direct growth", "2026-11-19")
    assert [(result["symbol"], result["name"]) for result in results] == [
        ("AMFI-122639", "Example Equity Fund · Direct Plan · Growth"),
    ]


def test_fund_chart_filters_future_and_invalid_navs(monkeypatch, uncached_amfi):
    source = {
        "meta": {"scheme_name": "Example Equity Fund · Direct Growth"},
        "data": [
            {"date": "20-11-2026", "nav": "70"},
            {"date": "18-11-2026", "nav": "33"},
            {"date": "17-11-2026", "nav": "inf"},
            {"date": "18-10-2026", "nav": "30"},
        ],
    }
    monkeypatch.setattr(amfi.requests, "get", lambda *a, **kw: SimpleNamespace(
        json=lambda: source, raise_for_status=lambda: None,
    ))
    result = chart_data(resolve_symbol("122639"), "2026-11-19", {})
    assert result["kind"] == "fund"
    assert result["currency"] == "INR"
    assert result["source"] == "MFapi · AMFI NAV"
    assert result["bars"] == [
        {"time": "2026-10-18", "close": 30}, {"time": "2026-11-18", "close": 33},
    ]
    assert result["performance"]["1M"] == pytest.approx(10)
    assert result["benchmark"] is None
