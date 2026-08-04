"""Normalize the box-level transfer workbook for the logistics control tower."""

from __future__ import annotations

import io
from datetime import date, datetime
from typing import Any

import pandas as pd


REQUIRED_FIELDS = ["调拨单号", "箱号（赫特）", "物流商", "提货时间"]


def _clean(value: Any) -> Any:
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
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _datetime(value: Any) -> datetime | None:
    value = _clean(value)
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
    if isinstance(value, (int, float)):
        # Feishu Base dates are commonly milliseconds since Unix epoch.
        if value > 10_000_000_000:
            return datetime.fromtimestamp(value / 1000)
        if value > 1_000_000_000:
            return datetime.fromtimestamp(value)
    parsed = pd.to_datetime(value, errors="coerce")
    if pd.isna(parsed):
        return None
    return parsed.to_pydatetime()


def _iso_day(value: Any) -> str | None:
    parsed = _datetime(value)
    return parsed.strftime("%Y-%m-%d") if parsed else None


def _normalize_team(value: Any) -> str:
    text = _text(value)
    lower = text.lower()
    if "frodio" in lower:
        return "FRODIO亚马逊" if "亚马逊" in text else "FRODIO"
    if lower == "onnat":
        return "OnNat"
    return text


def _is_exception(value: Any) -> bool:
    text = _text(value, "")
    return bool(text and text not in {"否", "无异常", "未填写", "0", "False", "false"})


def parse_workbook(data: bytes, file_name: str, now: datetime | None = None) -> dict[str, Any]:
    if not file_name.lower().endswith((".xlsx", ".xls")):
        raise ValueError("请选择 Excel 文件（.xlsx 或 .xls）")
    now = now or datetime.now()
    frame = pd.read_excel(io.BytesIO(data), sheet_name=0)
    frame.columns = [str(column).strip() for column in frame.columns]
    frame = frame.dropna(how="all")
    missing_fields = [field for field in REQUIRED_FIELDS if field not in frame.columns]
    if missing_fields:
        raise ValueError(f"表格缺少必要字段：{'、'.join(missing_fields)}")
    has_anomaly_field = "是否异常" in frame.columns

    records: list[dict[str, Any]] = []
    invalid_duration_count = 0
    for _, source in frame.iterrows():
        row = source.to_dict()
        pickup = _datetime(row.get("提货时间"))
        receipt = _datetime(row.get("物流签收时间"))
        shelf = _datetime(row.get("上架时间"))
        expected_receipt = _datetime(row.get("预计签收时间"))
        expected_shelf = _datetime(row.get("预计上架时间"))
        requirement = _number(row.get("时效要求"))
        duration = _number(row.get("签出-签收时效"))
        if duration is not None and not 0 <= duration <= 365:
            duration = None
            invalid_duration_count += 1
        ontime = None if duration is None or requirement is None else duration <= requirement
        overdue_unreceived = receipt is None and expected_receipt is not None and expected_receipt.date() < now.date()
        overdue_unshelved = receipt is not None and shelf is None and expected_shelf is not None and expected_shelf.date() < now.date()
        overdue_days = 0
        if overdue_unreceived and expected_receipt:
            overdue_days = max(0, (now.date() - expected_receipt.date()).days)
        elif overdue_unshelved and expected_shelf:
            overdue_days = max(0, (now.date() - expected_shelf.date()).days)

        logistics_exception = _text(row.get("是否物流异常"), "无异常")
        shelf_exception = _text(row.get("是否上架异常"), "无异常")
        provider = _text(row.get("物流商"))
        channel = _text(row.get("物流渠道"))
        tracking = _text(row.get("物流跟踪号"), "")
        last_mile = _text(row.get("尾程类型"))

        records.append({
            "pickupDate": _iso_day(pickup),
            "order": _text(row.get("调拨单号"), ""),
            "box": _text(row.get("箱号（赫特）"), ""),
            "team": _normalize_team(row.get("团队")),
            "category": _text(row.get("一级分类")),
            "origin": _text(row.get("发货仓库")),
            "provider": "未识别" if provider == "0" else provider,
            "channel": "未识别" if channel == "0" else channel,
            "transport": _text(row.get("运输类型")),
            "lastMile": last_mile,
            "destination": _text(row.get("目的仓库")),
            "status": _text(_clean(row.get("物流状态（细分）")) or row.get("物流状态"), "未更新"),
            "requirement": requirement,
            "duration": duration,
            "ontime": ontime,
            "anomaly": _is_exception(row.get("是否异常")) if has_anomaly_field else (_is_exception(logistics_exception) or _is_exception(shelf_exception)),
            "logisticsException": logistics_exception,
            "shelfException": shelf_exception,
            "verification": _text(row.get("状态与异常核实"), "未处理"),
            "description": _text(row.get("异常事件描述（物流商填写）"), "无"),
            "receiptDate": _iso_day(receipt),
            "shelfDate": _iso_day(shelf),
            "expectedReceiptDate": _iso_day(expected_receipt),
            "expectedShelfDate": _iso_day(expected_shelf),
            "overdueUnreceived": overdue_unreceived,
            "overdueUnshelved": overdue_unshelved,
            "overdueDays": overdue_days,
            "trackingMissing": last_mile == "未更新跟踪号" or not tracking,
        })

    return {
        "sourceName": file_name,
        "updatedAt": now.strftime("%Y-%m-%d %H:%M"),
        "rows": len(records),
        "columnCount": len(frame.columns),
        "invalidDurationCount": invalid_duration_count,
        "records": records,
    }
