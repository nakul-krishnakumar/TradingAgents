"""Yahoo instrument lookups for ticker selection."""

import yfinance as yf


def lookup_quotes(query: str) -> list[dict]:
    return yf.Search(query, max_results=15, news_count=0, enable_fuzzy_query=False, timeout=8).quotes
