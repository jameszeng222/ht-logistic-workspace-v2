"""Normalize Feishu bulk-freight records for the logistics quote dashboard."""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any

import pandas as pd


REQUIRED_FIELDS = ["调拨单号", "物流商", "单价"]


def _clean(value: Any) -> Any:
    if isinstance(value, dict):
        for key in ("text", "value", "name"):
            if key in value:
                return _clean(value[key])
        return None
    if isinstance(value, list):
        values = [_clean(item) for item in value]
        values = [item for item in values if item is not None]
        if not values:
            return None
        return values[0] if len(values) == 1 else "、".join(str(item) for item in values)
    if value is None or (not isinstance(value, (list, dict)) and pd.isna(value)):
        return None
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def _text(value: Any, fallback: str = "未填写") -> str:
    value = _clean(value)
    if value is None:
        return fallback
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _number(value: Any) -> float | None:
    value = _clean(value)
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).replace(",", "").replace("￥", "").replace("¥", "").strip()
    if re.fullmatch(r"[-+]?\d+(?:\.\d+)?", text):
        return float(text)
    return None


def _datetime(value: Any) -> datetime | None:
    value = _clean(value)
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
    numeric = None
    if isinstance(value, (int, float)):
        numeric = float(value)
    elif isinstance(value, str):
        try:
            numeric = float(value)
        except ValueError:
            pass
    parsed = None
    if numeric is not None:
        if numeric > 10_000_000_000:
            parsed = datetime.fromtimestamp(numeric / 1000)
        elif numeric > 1_000_000_000:
            parsed = datetime.fromtimestamp(numeric)
        elif 20_000 <= numeric <= 80_000:
            parsed = pd.to_datetime(numeric, unit="D", origin="1899-12-30").to_pydatetime()
    if parsed is None:
        converted = pd.to_datetime(value, errors="coerce")
        if not pd.isna(converted):
            parsed = converted.to_pydatetime()
    return parsed if parsed is not None and 2000 <= parsed.year <= 2100 else None


def parse_values(values: list[list[Any]], source_name: str, now: datetime | None = None) -> dict[str, Any]:
    if not values or not values[0]:
        raise ValueError("飞书大货运费表没有可读取的数据")
    headers = [str(_clean(value) or "").strip() for value in values[0]]
    missing = [field for field in REQUIRED_FIELDS if field not in headers]
    if missing:
        raise ValueError(f"大货运费表缺少必要字段：{'、'.join(missing)}")
    width = len(headers)
    rows = [(list(row) + [None] * width)[:width] for row in values[1:]]
    frame = pd.DataFrame(rows, columns=headers).dropna(how="all")

    records: list[dict[str, Any]] = []
    for _, source in frame.iterrows():
        row = source.to_dict()
        price_text = _text(row.get("单价"), "")
        price = _number(row.get("单价"))
        pickup = _datetime(row.get("提货日期"))
        freight = _number(row.get("运费（不含国内税点）"))
        charges = {
            "customsFee": _number(row.get("报关费")),
            "insuranceFee": _number(row.get("保险费")),
            "miscFee": _number(row.get("杂费")),
            "duty": _number(row.get("关税")),
            "surcharge": _number(row.get("补收+")),
            "deduction": _number(row.get("调减-")),
        }
        total = _number(row.get("总金额"))
        known_charge_total = sum(charges[key] or 0 for key in ("customsFee", "insuranceFee", "miscFee", "duty", "surcharge"))
        calculated_total = (freight or 0) + known_charge_total - (charges["deduction"] or 0)
        has_complex_rate = bool(price_text and price is None)
        normalized_total = total if total not in (None, 0) else (calculated_total if calculated_total else total)
        records.append({
            "pickupDate": pickup.strftime("%Y-%m-%d") if pickup else None,
            "order": _text(row.get("调拨单号"), ""),
            "origin": _text(row.get("发货地")),
            "destination": _text(row.get("目的地")),
            "transport": _text(row.get("运输类型")),
            "channel": _text(row.get("物流渠道")),
            "provider": _text(row.get("物流商")),
            "category": _text(row.get("一级分类")),
            "product": _text(row.get("品名")),
            "unitPrice": price,
            "unitPriceText": price_text,
            "billingWeight": _number(row.get("渠道计费重（确认计费重）")),
            "freight": freight,
            **charges,
            "total": normalized_total,
            "boxes": _number(row.get("箱数（以此为准）")),
            "pieces": _number(row.get("件数（以此为准）")),
            "customsDeclared": _text(row.get("是否报关"), "未填写"),
            "hasComplexRate": has_complex_rate,
            "missingAmount": normalized_total in (None, 0),
        })

    return {
        "sourceName": source_name or "大货运费表",
        "updatedAt": (now or datetime.now()).strftime("%Y-%m-%d %H:%M"),
        "rows": len(records),
        "columnCount": len(headers),
        "records": records,
    }
