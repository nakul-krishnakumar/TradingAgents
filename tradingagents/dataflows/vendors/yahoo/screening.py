"""Current NSE-company net income ranges from Yahoo's equity screener."""

from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import yfinance as yf
from yfinance.exceptions import YFException

_NET_INCOME = "netincomeis.lasttwelvemonths"
_PAGE_SIZE = 250


@lru_cache(maxsize=24)
def net_income_matches(day: str, minimum: float | None, maximum: float | None) -> tuple[str, ...]:
    clauses = [yf.EquityQuery("eq", ["region", "in"]), yf.EquityQuery("eq", ["exchange", "NSI"])]
    for operation, threshold in (("gte", minimum), ("lte", maximum)):
        if threshold is not None:
            clauses.append(yf.EquityQuery(operation, [_NET_INCOME, threshold]))
    query = yf.EquityQuery("and", clauses)

    def page(offset):
        try:
            return yf.screen(query, offset=offset, size=_PAGE_SIZE, sortField=_NET_INCOME, sortAsc=False)
        except YFException as exc:
            raise RuntimeError("Yahoo's net income screener is temporarily unavailable.") from exc

    first = page(0)
    offsets = range(_PAGE_SIZE, first["total"], _PAGE_SIZE)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = [first, *pool.map(page, offsets)]
    return tuple(dict.fromkeys(
        quote["symbol"] for result in results for quote in result["quotes"]
        if quote.get("symbol", "").endswith(".NS") and quote.get("currency") == "INR"
    ))
