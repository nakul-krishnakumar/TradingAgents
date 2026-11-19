"""Local cross-browser wishlists and a transactionally updated paper ledger."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .market import exchange_for, kind_for, resolve_symbol

CASH_UNIT = Decimal("0.01")
ZERO = Decimal(0)
AssetKind = Literal["stock", "etf", "fund", "bond", "index", "crypto", "other"]


class Asset(BaseModel):
    symbol: str = Field(min_length=1, max_length=40)
    name: str = Field(default="", max_length=300)
    kind: AssetKind = "stock"
    exchange: str = Field(default="", max_length=40)

    @field_validator("symbol")
    @classmethod
    def validate_symbol(cls, value):
        return resolve_symbol(value)

    def stored(self):
        return {
            "symbol": self.symbol, "name": self.name.strip() or self.symbol,
            "kind": kind_for(self.symbol, self.kind), "exchange": self.exchange.strip() or exchange_for(self.symbol),
        }


class Named(BaseModel):
    name: str = Field(min_length=1, max_length=70)

    @field_validator("name")
    @classmethod
    def trim_name(cls, value):
        if not value.strip():
            raise ValueError("Enter a name.")
        return value.strip()


class Target(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    asset: Asset
    weight: Decimal = Field(ge=0, le=100, decimal_places=4)


class BasketSpec(Named):
    model_config = ConfigDict(allow_inf_nan=False)

    capital: Decimal = Field(default=Decimal("100000"), gt=0, max_digits=15, decimal_places=2)
    targets: list[Target] = Field(default_factory=list, max_length=40)


class BasketTargets(BaseModel):
    targets: list[Target] = Field(max_length=40)


class PaperOrder(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)

    request_id: str = Field(pattern=r"^[a-zA-Z0-9-]{12,72}$")
    asset: Asset
    side: Literal["buy", "sell"]
    units: Decimal = Field(gt=0, max_digits=15, decimal_places=6)
    price: Decimal | None = Field(default=None, gt=0, max_digits=15, decimal_places=6)
    fee: Decimal = Field(default=ZERO, ge=0, max_digits=12, decimal_places=2)


def cash_value(value: Decimal) -> Decimal:
    return value.quantize(CASH_UNIT, rounding=ROUND_HALF_UP)


def validate_targets(targets: list[Target]) -> list[dict]:
    result = [{"asset": target.asset.stored(), "weight": str(target.weight)} for target in targets]
    if len({target["asset"]["symbol"] for target in result}) != len(result):
        raise ValueError("A symbol can appear only once in a basket.")
    if sum((target.weight for target in targets), ZERO) > 100:
        raise ValueError("Target weights must add up to 100% or less.")
    return result


def ledger(capital: str, orders: list[dict]) -> dict:
    """Replay fills and track remaining cost basis and realized gain separately."""
    cash, realized = Decimal(capital), ZERO
    positions = {}
    for order in orders:
        asset = order["asset"]
        units = Decimal(order["units"])
        gross = cash_value(units * Decimal(order["price"]))
        fee = Decimal(order["fee"])
        symbol = asset["symbol"]
        position = positions.setdefault(symbol, {"asset": asset, "units": ZERO, "cost": ZERO})
        if order["side"] == "buy":
            cash -= gross + fee
            position["units"] += units
            position["cost"] += gross + fee
        else:
            book_cost = cash_value(position["cost"] * units / position["units"])
            cash += gross - fee
            realized += gross - fee - book_cost
            position["units"] -= units
            position["cost"] -= book_cost

    return {
        "cash": str(cash), "realized": str(realized),
        "positions": [
            {"asset": value["asset"], "units": str(value["units"]), "cost": str(value["cost"]),
             "entry": str(cash_value(value["cost"] / value["units"]))}
            for value in positions.values() if value["units"] > 0
        ],
    }


class WorkspaceStore:
    def __init__(self, path: Path):
        self.path = path

    @contextmanager
    def _connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path, timeout=15)) as connection, connection:
            connection.row_factory = sqlite3.Row
            connection.execute(
                "CREATE TABLE IF NOT EXISTS workspace_library("
                "id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE, "
                "payload TEXT NOT NULL, UNIQUE(kind, name))"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS market_votes("
                "symbol TEXT NOT NULL, voter TEXT NOT NULL, stance TEXT NOT NULL, "
                "day TEXT NOT NULL, PRIMARY KEY(symbol, voter, day))"
            )
            yield connection

    @staticmethod
    def _item(row):
        if row is None:
            raise LookupError("This item could not be found.")
        payload = json.loads(row["payload"])
        return {"id": row["id"], "name": row["name"], **payload}

    def list(self, kind: str) -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, name, payload FROM workspace_library WHERE kind=? ORDER BY name", (kind,),
            )
            return [self._item(row) for row in rows]

    def get(self, kind: str, identifier: str) -> dict:
        with self._connect() as connection:
            return self._item(connection.execute(
                "SELECT id, name, payload FROM workspace_library WHERE kind=? AND id=?", (kind, identifier),
            ).fetchone())

    def create(self, kind: str, name: str, payload: dict) -> dict:
        identifier = uuid4().hex
        try:
            with self._connect() as connection:
                connection.execute("INSERT INTO workspace_library VALUES (?, ?, ?, ?)",
                                   (identifier, kind, name, json.dumps(payload, ensure_ascii=False)))
        except sqlite3.IntegrityError:
            raise ValueError(f'A {kind} named "{name}" already exists.') from None
        return {"id": identifier, "name": name, **payload}

    def update(self, kind: str, identifier: str, change: Callable) -> dict:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT id, name, payload FROM workspace_library WHERE kind=? AND id=?", (kind, identifier),
            ).fetchone()
            item = self._item(row)
            payload = json.loads(row["payload"])
            change(payload)
            connection.execute("UPDATE workspace_library SET payload=? WHERE id=?",
                               (json.dumps(payload, ensure_ascii=False), identifier))
            return {"id": item["id"], "name": item["name"], **payload}

    def remove(self, kind: str, identifier: str):
        with self._connect() as connection:
            deleted = connection.execute(
                "DELETE FROM workspace_library WHERE kind=? AND id=?", (kind, identifier),
            )
            if not deleted.rowcount:
                raise LookupError("This item could not be found.")

    def set_wishlist(self, identifier: str, asset: Asset, included: bool) -> dict:
        item = asset.stored()

        def change(payload):
            items = {entry["symbol"]: entry for entry in payload["assets"]}
            if included:
                items[item["symbol"]] = item
            else:
                items.pop(item["symbol"], None)
            payload["assets"] = list(items.values())

        return self.update("wishlist", identifier, change)

    def basket(self, identifier: str) -> dict:
        return basket_details(self.get("basket", identifier))

    def fill(self, identifier: str, order: PaperOrder, price: Decimal, source: str, session: str | None):
        def change(payload):
            _append_order(payload, order, price, source, session)
        return basket_details(self.update("basket", identifier, change))

    def fill_batch(self, identifier: str, fills: list[tuple]):
        def change(payload):
            for order, price, source, session in fills:
                _append_order(payload, order, price, source, session)
        return basket_details(self.update("basket", identifier, change))

    def vote(self, symbol: str, voter: str, stance: str, day: str):
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO market_votes (symbol, voter, stance, day) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(symbol, voter, day) DO UPDATE SET stance=excluded.stance",
                (symbol, voter, stance, day),
            )

    def votes(self, day: str):
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT symbol, stance, COUNT(*) AS votes FROM market_votes WHERE day=? GROUP BY symbol, stance",
                (day,),
            )
            result = {}
            for row in rows:
                group = result.setdefault(row["symbol"], {"bullish": 0, "neutral": 0, "bearish": 0, "total": 0})
                group[row["stance"]] = row["votes"]
                group["total"] += row["votes"]
            return result


def _append_order(payload, order: PaperOrder, price: Decimal, source: str, session: str | None):
    if any(existing["request_id"] == order.request_id for existing in payload["orders"]):
        return
    item = order.asset.stored()
    book = ledger(payload["capital"], payload["orders"])
    gross = cash_value(order.units * price)
    if gross <= 0:
        raise ValueError("The order value must be at least ₹0.01.")
    if order.side == "buy":
        if gross + order.fee > Decimal(book["cash"]):
            raise ValueError("The basket has insufficient paper cash for this order.")
    else:
        units = next((Decimal(entry["units"]) for entry in book["positions"]
                      if entry["asset"]["symbol"] == item["symbol"]), ZERO)
        if order.units > units:
            raise ValueError("The basket does not hold this many units.")
        if order.fee > gross:
            raise ValueError("The estimated fee exceeds the sale proceeds.")
    payload["orders"].append({
        "request_id": order.request_id, "asset": item, "side": order.side,
        "units": str(order.units), "price": str(price), "fee": str(order.fee),
        "source": source, "session": session, "filled_at": datetime.now(UTC).isoformat(),
    })


def basket_details(item: dict) -> dict:
    return {**item, **ledger(item["capital"], item["orders"])}
