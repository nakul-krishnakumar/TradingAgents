"""AMFI's scheme directory and the MFapi mirror of published NAV history."""

import csv
import io
import math
import re
import unicodedata
from datetime import date, datetime, timedelta
from functools import lru_cache
from zipfile import BadZipFile

import requests

AMFI_DIRECTORY = "https://portal.amfiindia.com/spages/NAVAll.txt"
AMFI_TER = "https://www.amfiindia.com/ter-of-mf-schemes"
FUND_HISTORY = "https://api.mfapi.in/mf"


@lru_cache(maxsize=4)
def fund_directory(day: str, interval: int = 0) -> tuple[dict, ...]:
    response = requests.get(AMFI_DIRECTORY, timeout=12)
    response.raise_for_status()
    response.encoding = "utf-8-sig"
    rows = csv.reader(response.text.splitlines(), delimiter=";")
    header = next(rows, [])
    result = []
    category, fund_house = "", ""
    for fields in rows:
        if not fields:
            continue
        if len(fields) == 1:
            label = fields[0].strip()
            if "schemes" in label.casefold():
                category = label.split("(", 1)[-1].rstrip(")").strip()
                fund_house = ""
            elif label:
                fund_house = label
            continue
        row = dict(zip(header, fields, strict=False))
        code = (row.get("Scheme Code") or "").strip()
        name = (row.get("Scheme Name") or "").strip()
        if not re.fullmatch(r"\d{5,6}", code) or not name:
            continue
        qualifiers = [row.get(field, "").strip() for field in ("Plan", "Option")]
        label = " · ".join([name, *(value for value in qualifiers if value)])
        raw_date = row.get("Date", "").strip()
        try:
            published = datetime.strptime(raw_date, "%d-%b-%Y").date().isoformat()
        except ValueError:
            published = ""
        try:
            nav = float(row.get("Net Asset Value", ""))
            nav = nav if math.isfinite(nav) and nav > 0 else None
        except ValueError:
            nav = None
        result.append({
            "code": code, "name": label, "scheme_name": name, "category": category, "fund_house": fund_house,
            "plan": qualifiers[0], "option": qualifiers[1], "nav": nav, "date": published,
            "isin": row.get("ISIN Div Payout/ ISIN Growth", "").strip(),
        })
    return tuple(result)


@lru_cache(maxsize=128)
def fund_nav(symbol: str, day: str) -> tuple[dict, tuple[dict, ...]]:
    response = requests.get(f"{FUND_HISTORY}/{symbol.removeprefix('AMFI-')}", timeout=15)
    response.raise_for_status()
    payload = response.json()
    metadata = payload.get("meta") or {}
    prices = {}
    for item in payload.get("data") or ():
        try:
            nav = float(item["nav"])
            stamp = datetime.strptime(item["date"], "%d-%m-%Y").date().isoformat()
        except (TypeError, ValueError, KeyError):
            continue
        if stamp <= day and math.isfinite(nav) and nav > 0:
            prices[stamp] = {"time": stamp, "close": nav}
    if not prices:
        raise ValueError(f"No NAV was available for {symbol} through {day}.")
    return metadata, tuple(prices[key] for key in sorted(prices))


@lru_cache(maxsize=8)
def latest_previous_navs(through: str) -> dict[str, tuple[str, float]]:
    """Per-scheme NAVs from the official historical download, at or before a date."""
    end = date.fromisoformat(through)
    start = end - timedelta(days=4)
    response = requests.get(
        "https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx",
        params={"frmdt": start.strftime("%d-%b-%Y"), "todt": end.strftime("%d-%b-%Y")},
        timeout=16,
    )
    response.raise_for_status()
    response.encoding = "utf-8-sig"
    result = {}
    for row in csv.DictReader(response.text.splitlines(), delimiter=";"):
        code = (row.get("Scheme Code") or "").strip()
        if not re.fullmatch(r"\d{5,6}", code):
            continue
        try:
            day = datetime.strptime(row.get("Date", "").strip(), "%d-%b-%Y").date().isoformat()
            nav = float(row.get("Net Asset Value", ""))
        except (ValueError, TypeError):
            continue
        if math.isfinite(nav) and nav > 0 and day <= through and day > result.get(code, ("", 0))[0]:
            result[code] = (day, nav)
    return result


def scheme_key(name: str) -> str:
    return "".join(char for char in unicodedata.normalize("NFKC", name).casefold() if char.isalnum())


@lru_cache(maxsize=3)
def expense_ratios(through: str) -> dict[str, dict[str, tuple[str, float]]]:
    """Use the latest available plan rate for each unambiguous AMFI scheme name."""
    from openpyxl import load_workbook
    from openpyxl.utils.exceptions import InvalidFileException

    end = date.fromisoformat(through)
    for month in (end, end.replace(day=1) - timedelta(days=1)):
        response = requests.get("https://www.amfiindia.com/api/populate-te-rdata-revised", params={
            "MF_ID": "All", "Month": month.strftime("%m-%Y"), "strCat": "-1", "strType": "-1", "excel": "true",
        }, timeout=24)
        response.raise_for_status()
        try:
            workbook = load_workbook(io.BytesIO(response.content), read_only=True, data_only=True)
        except (BadZipFile, InvalidFileException) as exc:
            if month == end and end.day <= 6:
                continue
            raise ValueError("AMFI did not return a valid TER workbook.") from exc
        codes, rates = {}, {}
        try:
            rows = workbook.active.iter_rows(values_only=True, max_col=15)
            columns = {label: index for index, label in enumerate(next(rows, ())) if label}
            identity, scheme, published, regular, direct = (columns[label] for label in (
                "NSDL Scheme Code", "Scheme Name", "TER Date",
                "Regular Plan - Total TER (%)", "Direct Plan - Total TER (%)",
            ))
            for row in rows:
                if not row[identity] or not row[scheme] or not isinstance(row[published], (date, datetime)):
                    continue
                stamp = row[published].isoformat()[:10]
                if stamp > through:
                    continue
                key = scheme_key(str(row[scheme]))
                codes.setdefault(key, set()).add(row[identity])
                scheme_rates = rates.setdefault(key, {})
                for plan, index in (("regular plan", regular), ("direct plan", direct)):
                    number = row[index]
                    if (isinstance(number, (int, float)) and math.isfinite(number) and 0 <= number < 100
                            and stamp >= scheme_rates.get(plan, ("", 0))[0]):
                        scheme_rates[plan] = (stamp, float(number))
        finally:
            workbook.close()
        if rates:
            return {key: entry for key, entry in rates.items() if len(codes[key]) == 1 and entry}
    return {}
