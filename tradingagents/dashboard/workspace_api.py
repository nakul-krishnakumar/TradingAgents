"""Screener, market signals, named lists and INR paper accounts."""

from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from decimal import ROUND_DOWN, Decimal
from pathlib import Path
from time import time
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from tradingagents.dataflows.config import run_config
from tradingagents.dataflows.date_window import get_current_date
from tradingagents.dataflows.vendors.stocktwits import fetch_stocktwits_messages
from tradingagents.diagnostics import event, exception_fields, submit_traced

from .market import chart_data, resolve_symbol
from .screener import EnrichRequest, ScreenRequest, describe_axes, enrich, latest_snapshot, screen
from .trends import AMFI_FLOWS, fund_movers, trends_view
from .workspace_store import (
    ZERO,
    Asset,
    BasketSpec,
    BasketTargets,
    Named,
    PaperOrder,
    WorkspaceStore,
    cash_value,
    validate_targets,
)

SMALLCASE_TRENDING = "https://www.smallcase.com/collection/6a952801e2300b11a1484495"
POPULAR = (
    {"name": "Omni Bharat Defence", "theme": "Defence", "url": "https://www.smallcase.com/smallcase/OMNNM_0012"},
    {"name": "Mi 20 Momentum", "theme": "Momentum", "url": "https://www.smallcase.com/smallcase/WKIMO_0017"},
    {"name": "AI & Data Center", "theme": "Technology", "url": "https://www.smallcase.com/smallcase/GRINMX_0003"},
    {"name": "Green Energy", "theme": "Energy", "url": "https://www.smallcase.com/smallcase/NIVTR_0001"},
    {"name": "CWA Smallcap Fund Picks", "theme": "Mutual funds", "url": "https://www.smallcase.com/smallcase/MF_COWAQM_0001"},
)
_STANCES = re.compile(r"^Bullish: (\d+) .*?Bearish: (\d+) .*?Unlabeled: (\d+) .*?Total: (\d+)", re.MULTILINE)
logger = logging.getLogger(__name__)


class WishlistChange(BaseModel):
    asset: Asset
    included: bool = True


class FundingOrder(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    request_id: str = Field(pattern=r"^[a-zA-Z0-9-]{12,66}$")
    budget: Decimal = Field(gt=0, max_digits=15, decimal_places=2)
    fee: Decimal = Field(default=ZERO, ge=0, max_digits=12, decimal_places=2)


class SentimentVote(BaseModel):
    symbol: str = Field(min_length=1, max_length=40)
    voter: str = Field(pattern=r"^[a-zA-Z0-9-]{12,72}$")
    stance: Literal["bullish", "neutral", "bearish"]


class DiscussionRequest(BaseModel):
    assets: list[Asset] = Field(min_length=1, max_length=5)


def sample_discussion(request: DiscussionRequest, day: str):
    start = (date.fromisoformat(day) - timedelta(days=7)).isoformat()
    assets = {asset.symbol: asset.stored() for asset in request.assets
              if asset.stored()["kind"] in {"stock", "etf", "crypto"}}
    samples = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        pending = {symbol: submit_traced(pool,
            fetch_stocktwits_messages, symbol, 25, 6, start, day,
        ) for symbol in assets}
        for symbol, action in pending.items():
            sample = action.result()
            match = _STANCES.search(sample)
            counts = dict(zip(("bullish", "bearish", "unlabeled", "total"),
                              map(int, match.groups()), strict=True)) if match else None
            samples.append({"asset": assets[symbol], "counts": counts})
    return {"samples": samples, "start": start, "end": day, "source": "Stocktwits self-labeled posts"}


def _checked(operation, *args):
    try:
        return operation(*args)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


def quote_for(asset: dict, day: str, config: dict):
    kind, symbol = asset["kind"], asset["symbol"]
    if kind == "index":
        raise ValueError("An index is a benchmark. Select a traded fund or instrument for paper orders.")
    scope = kind if kind in {"stock", "fund", "bond", "etf"} else "other"
    if asset["exchange"] in ("NSE", "AMFI"):
        for row in latest_snapshot(day, scope)["rows"]:
            if row["symbol"] != symbol:
                continue
            price, stamp = row["metrics"].get("price"), row.get("observed")
            already_traded = kind != "bond" or row["metrics"].get("volume", 0) > 0
            if price and stamp and already_traded and (date.fromisoformat(day) - date.fromisoformat(stamp)).days <= 10:
                return {
                    "price": round(price, 6), "date": stamp, "currency": "INR",
                    "source": row.get("price_source") or row["source"],
                    "lot": row["metrics"].get("lot") or 1,
                }
            break
    if kind != "bond":
        try:
            with run_config(config):
                chart = chart_data(symbol, day, config, kind)
            latest = chart["last"]
            if chart.get("currency") == "INR" and (date.fromisoformat(day) - date.fromisoformat(latest["time"])).days <= 10:
                return {"price": round(latest["close"], 6), "date": latest["time"], "currency": "INR",
                        "source": chart["source"] + " · " + chart["pricing"], "lot": 1}
        except (OSError, ValueError, RuntimeError) as exc:
            event(logger, "data.paper_quote_failed", "Could not retrieve a reference price",
                  level=logging.WARNING, symbol=symbol, date=day, **exception_fields(exc))
    raise ValueError(f"A recent INR quote is unavailable for {symbol}. Enter a manual INR price for a paper fill.")


def _quotes(assets, day, config):
    results, unavailable = {}, {}
    with ThreadPoolExecutor(max_workers=5) as pool:
        pending = {asset["symbol"]: submit_traced(pool, quote_for, asset, day, config) for asset in assets}
        for symbol, action in pending.items():
            try:
                results[symbol] = action.result()
            except ValueError as exc:
                unavailable[symbol] = str(exc)
                event(logger, "data.paper_quote_unavailable", "A basket price was unavailable",
                      level=logging.WARNING, symbol=symbol, **exception_fields(exc))
            except (OSError, RuntimeError) as exc:
                unavailable[symbol] = "This quote source is temporarily unavailable."
                event(logger, "data.paper_quote_failed", "A basket price could not be fetched",
                      level=logging.WARNING, symbol=symbol, **exception_fields(exc))
    return results, unavailable


def workspace_router(config: dict):
    router = APIRouter(prefix="/api")
    store = WorkspaceStore(Path(config["results_dir"]) / "dashboard" / "workspace.sqlite3")

    @router.get("/screener/axes")
    def screener_axes():
        return describe_axes()

    @router.post("/screener")
    def run_screen(request: ScreenRequest):
        result = _checked(screen, request, get_current_date(), config)
        event(logger, "screener.completed", "Investment filters applied", investment_type=request.kind, sort=request.sort,
              filters=[item.key for item in request.filters], matches=result["total"], unavailable=result["unavailable"])
        return result

    @router.post("/screener/enrich")
    def enrich_screen(request: EnrichRequest):
        return enrich(request, get_current_date(), config)

    @router.get("/wishlists")
    def all_wishlists():
        return store.list("wishlist")

    @router.post("/wishlists", status_code=201)
    def create_wishlist(request: Named):
        item = _checked(store.create, "wishlist", request.name, {"assets": []})
        event(logger, "wishlist.created", "Saved list created", wishlist_id=item["id"])
        return item

    @router.post("/wishlists/{identifier}/assets")
    def wishlist_asset(identifier: str, request: WishlistChange):
        item = _checked(store.set_wishlist, identifier, request.asset, request.included)
        event(logger, "wishlist.changed", "Saved list membership changed", wishlist_id=identifier,
              symbol=request.asset.symbol, included=request.included)
        return item

    @router.delete("/wishlists/{identifier}")
    def delete_wishlist(identifier: str):
        _checked(store.remove, "wishlist", identifier)
        event(logger, "wishlist.deleted", "Saved list deleted", wishlist_id=identifier)
        return {"deleted": True}

    @router.get("/baskets/popular")
    def popular_baskets():
        return {"publisher": "smallcase", "featured": POPULAR, "collection": SMALLCASE_TRENDING,
                "source": SMALLCASE_TRENDING, "checked_on": "2026-11-19"}

    @router.get("/baskets")
    def all_baskets():
        return [{
            "id": entry["id"], "name": entry["name"], "capital": entry["capital"],
            "targets": len(entry["targets"]), "fills": len(entry["orders"]),
        } for entry in store.list("basket")]

    @router.post("/baskets", status_code=201)
    def create_basket(request: BasketSpec):
        targets = _checked(validate_targets, request.targets)
        item = _checked(store.create, "basket", request.name, {
            "capital": str(request.capital), "targets": targets, "orders": [],
        })
        event(logger, "basket.created", "Practice portfolio created", basket_id=item["id"], funds=str(request.capital))
        return store.basket(item["id"])

    @router.get("/baskets/{identifier}")
    def get_basket(identifier: str):
        return _checked(store.basket, identifier)

    @router.post("/baskets/{identifier}/targets")
    def update_targets(identifier: str, request: BasketTargets):
        targets = _checked(validate_targets, request.targets)
        _checked(store.update, "basket", identifier, lambda item: item.update(targets=targets))
        event(logger, "basket.targets_saved", "Practice portfolio weights saved", basket_id=identifier,
              targets=len(targets))
        return store.basket(identifier)

    @router.post("/paper/quote")
    def paper_quote(asset: Asset):
        return _checked(quote_for, asset.stored(), get_current_date(), config)

    @router.post("/baskets/{identifier}/marks")
    def mark_basket(identifier: str):
        item = _checked(store.basket, identifier)
        prices, unavailable = _quotes([row["asset"] for row in item["positions"]], get_current_date(), config)
        return {"quotes": prices, "unavailable": unavailable}

    @router.post("/baskets/{identifier}/orders")
    def paper_order(identifier: str, request: PaperOrder):
        item = _checked(store.basket, identifier)
        if any(order["request_id"] == request.request_id for order in item["orders"]):
            return item
        if request.asset.kind == "index" or request.asset.symbol.startswith("^"):
            raise HTTPException(400, "An index is a benchmark. Choose a traded instrument.")
        source, session, price = "Manual INR price", None, request.price
        if price is None:
            quote = _checked(quote_for, request.asset.stored(), get_current_date(), config)
            source, session, price = quote["source"], quote["date"], Decimal(str(quote["price"]))
        updated = _checked(store.fill, identifier, request, price, source, session)
        event(logger, "basket.order_saved", "Practice portfolio order saved", basket_id=identifier,
              order_id=request.request_id, side=request.side, symbol=request.asset.symbol, quantity=str(request.units),
              price=str(price), fee=str(request.fee), source=source)
        return updated

    @router.post("/baskets/{identifier}/allocate")
    def fund_basket(identifier: str, request: FundingOrder):
        item = _checked(store.basket, identifier)
        if any(order["request_id"].startswith(request.request_id + "-") for order in item["orders"]):
            return item
        targets = [row for row in item["targets"] if Decimal(row["weight"]) > 0]
        if not targets:
            raise HTTPException(400, "Set positive target weights before simulating basket fills.")
        if request.budget > Decimal(item["cash"]):
            raise HTTPException(400, "The budget exceeds available paper cash.")
        quotes, unavailable = _quotes([row["asset"] for row in targets], get_current_date(), config)
        if unavailable:
            raise HTTPException(400, "Could not price every target in INR: " + ", ".join(unavailable))
        fills = []
        for index, target in enumerate(targets):
            asset = target["asset"]
            quote = quotes[asset["symbol"]]
            price = Decimal(str(quote["price"]))
            expected = request.budget * Decimal(target["weight"]) / 100 - request.fee
            lot = Decimal("0.000001") if asset["kind"] == "fund" else Decimal(str(quote["lot"]))
            units = (expected / price / lot).to_integral_value(rounding=ROUND_DOWN) * lot
            if units <= 0:
                raise HTTPException(400, f"The budget is too small for a market lot of {asset['symbol']}.")
            order = PaperOrder(request_id=f"{request.request_id}-{index}", asset=asset,
                               side="buy", units=units, fee=request.fee)
            fills.append((order, price, quote["source"], quote["date"]))
        if sum((cash_value(order.units * price) + order.fee for order, price, *_ in fills), ZERO) > request.budget:
            raise HTTPException(400, "Rounded fill values exceed this budget. Increase the budget or reduce fees.")
        updated = _checked(store.fill_batch, identifier, fills)
        event(logger, "basket.allocation_saved", "Practice portfolio purchases saved", basket_id=identifier,
              order_id=request.request_id, orders=len(fills), budget=str(request.budget))
        return updated

    @router.get("/market/trends")
    def markets():
        return trends_view(get_current_date())

    @router.get("/market/fund-movers")
    def current_fund_movers():
        try:
            return {**fund_movers(get_current_date(), int(time() // 900)), "flows_source": AMFI_FLOWS}
        except (OSError, ValueError, KeyError) as exc:
            event(logger, "data.fund_movers_failed", "Mutual fund price comparisons were unavailable",
                  level=logging.WARNING, **exception_fields(exc))
            return {"rows": [], "matched": 0, "session": "", "unavailable": True, "flows_source": AMFI_FLOWS}

    @router.post("/market/discussion")
    def market_discussion(request: DiscussionRequest):
        return sample_discussion(request, get_current_date())

    @router.get("/market/sentiment")
    def user_sentiment():
        day = get_current_date()
        return {"day": day, "votes": store.votes(day)}

    @router.post("/market/sentiment")
    def place_sentiment_vote(request: SentimentVote):
        symbol = "MARKET" if request.symbol.upper() == "MARKET" else _checked(resolve_symbol, request.symbol)
        day = get_current_date()
        store.vote(symbol, request.voter, request.stance, day)
        event(logger, "market.vote_saved", "Market opinion saved", symbol=symbol, stance=request.stance)
        return {"day": day, "votes": store.votes(day)}

    return router
