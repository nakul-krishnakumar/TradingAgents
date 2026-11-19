"""Published NSDL debt terms keyed by the instrument's ISIN."""

import csv
import re
from contextlib import suppress
from datetime import datetime
from functools import lru_cache

import requests

DEBT_MASTER = "https://nsdl.com/resources/data/detailed-list-debt-instruments"
_DEBT_FILE = re.compile(r'href="(/nsdl/[^"<>]+/Download_the_entire_list_of_Debt_Instruments[^"<>]+\.xls)"')
_RATING = re.compile(r"^(AAA|AA[+-]?|A[+-]?|BBB[+-]?|BB[+-]?|B[+-]?|C[+-]?|D)(?=\s|$)")
_RATING_DATE = re.compile(r"\bDT\s+(\d{2}-\d{2}-\d{4})\b")


@lru_cache(maxsize=2)
def debt_terms(day: str) -> dict[str, dict]:
    directory = requests.get(DEBT_MASTER, timeout=12)
    directory.raise_for_status()
    link = _DEBT_FILE.search(directory.text)
    if not link:
        raise ValueError("NSDL did not publish a machine-readable debt master link.")
    output = {}
    with requests.get("https://nsdl.com" + link[1], stream=True, timeout=20) as response:
        response.raise_for_status()
        response.encoding = "utf-8-sig"
        rows = csv.DictReader(response.iter_lines(decode_unicode=True), delimiter="\t")
        for row in rows:
            isin = row.get("ISIN", "")
            if not isin or len(isin) != 12:
                continue
            issued = row.get("ISSUE_PRICE") or ""
            frequency = (row.get("FREQUENCY_OF_THE_INTEREST_PAYMENT") or "").strip()
            report = (row.get("CREDIT_RATING_CREDIT_RATING_AGENCY") or "").strip()
            rating = _RATING.match(report)
            dated, stamp = _RATING_DATE.search(report), ""
            if dated:
                with suppress(ValueError):
                    stamp = datetime.strptime(dated[1], "%d-%m-%Y").date().isoformat()
            previous = output.get(isin)
            if stamp > day:
                continue
            if previous is None or (rating and (not previous["rating"] or stamp > previous["rating_date"])):
                output[isin] = {"issue_price": issued, "frequency": frequency,
                                "rating": rating[1] if rating else "", "rating_report": report,
                                "rating_date": stamp}
    return output
