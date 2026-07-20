"""Generic analysis for tabular logistics data pulled from Feishu Sheets."""

from __future__ import annotations

import json
from typing import Any

import pandas as pd


MAPPING_LABELS = {
    "customer": "客户",
    "status": "状态",
    "amount": "金额",
    "date": "日期",
    "tracking": "单号",
    "route": "线路",
}


def _cell_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return value


def _headers(values: list[list[Any]]) -> list[str]:
    raw = values[0] if values else []
    headers: list[str] = []
    used: dict[str, int] = {}
    for index, value in enumerate(raw, start=1):
        name = str(value).strip() if value is not None else ""
        name = name or f"未命名列{index}"
        used[name] = used.get(name, 0) + 1
        headers.append(name if used[name] == 1 else f"{name}_{used[name]}")
    return headers


def _frame(values: list[list[Any]]) -> pd.DataFrame:
    if not values or not values[0]:
        raise ValueError("表格中没有可分析的数据")
    headers = _headers(values)
    rows = []
    for row in values[1:]:
        normalized = [_cell_value(value) for value in row[: len(headers)]]
        normalized.extend([None] * (len(headers) - len(normalized)))
        if any(value not in (None, "") for value in normalized):
            rows.append(normalized)
    if not rows:
        raise ValueError("表格只有表头，没有数据行")
    return pd.DataFrame(rows, columns=headers)


def _kind(series: pd.Series) -> str:
    populated = series.dropna()
    populated = populated[populated.astype(str).str.strip() != ""]
    if populated.empty:
        return "empty"
    numeric = pd.to_numeric(populated, errors="coerce")
    if numeric.notna().mean() >= 0.8:
        return "numeric"
    dates = pd.to_datetime(populated, errors="coerce", format="mixed")
    if dates.notna().mean() >= 0.8:
        return "datetime"
    unique = populated.astype(str).nunique()
    return "categorical" if unique <= min(50, max(10, len(populated) // 2)) else "text"


def _display_number(value: float) -> str:
    if abs(value) >= 10000:
        return f"{value:,.0f}"
    return f"{value:,.2f}".rstrip("0").rstrip(".")


def analyze_values(
    values: list[list[Any]],
    mapping: dict[str, str] | None = None,
    source_name: str = "飞书表格",
) -> dict[str, Any]:
    if sum(len(row) for row in values) > 100_000:
        raise ValueError("单次分析最多支持 100,000 个单元格，请缩小读取范围")

    df = _frame(values)
    mapping = {key: value for key, value in (mapping or {}).items() if value in df.columns}
    row_count, column_count = df.shape
    blank_mask = df.apply(lambda column: column.isna() | column.astype(str).str.strip().eq(""))
    missing_cells = int(blank_mask.sum().sum())
    total_cells = max(row_count * column_count, 1)
    completeness = round((1 - missing_cells / total_cells) * 100, 1)

    profiles = []
    kinds: dict[str, str] = {}
    anomalies: list[dict[str, Any]] = []
    for column in df.columns:
        kind = _kind(df[column])
        kinds[column] = kind
        missing = int(blank_mask[column].sum())
        missing_pct = round(missing / row_count * 100, 1) if row_count else 0
        populated = df.loc[~blank_mask[column], column]
        profiles.append({
            "name": column,
            "kind": kind,
            "missing": missing,
            "missingPct": missing_pct,
            "unique": int(populated.astype(str).nunique()),
            "sample": [str(value) for value in populated.head(3).tolist()],
        })
        if missing_pct >= 20:
            anomalies.append({
                "severity": "warning",
                "title": f"{column} 缺失较多",
                "detail": f"{missing} 行为空，占 {missing_pct}%",
                "count": missing,
                "field": column,
            })

    duplicate_rows = int(df.astype(str).duplicated().sum())
    if duplicate_rows:
        anomalies.append({
            "severity": "warning",
            "title": "存在重复记录",
            "detail": f"发现 {duplicate_rows} 行完全重复的数据",
            "count": duplicate_rows,
            "field": None,
        })

    metrics = [
        {"key": "rows", "label": "数据记录", "value": f"{row_count:,}", "detail": f"{column_count} 个字段"},
        {"key": "complete", "label": "数据完整率", "value": f"{completeness}%", "detail": f"{missing_cells} 个空值"},
    ]

    customer_field = mapping.get("customer")
    if customer_field:
        customer_count = int(df.loc[~blank_mask[customer_field], customer_field].astype(str).nunique())
        metrics.append({"key": "customers", "label": "客户数量", "value": str(customer_count), "detail": customer_field})

    status_field = mapping.get("status")
    if status_field:
        statuses = df.loc[~blank_mask[status_field], status_field].astype(str)
        completed = int(statuses.str.contains("完成|签收|已发|closed|complete|delivered", case=False, regex=True).sum())
        metrics.append({"key": "completed", "label": "已完成记录", "value": f"{completed:,}", "detail": f"占 {round(completed / row_count * 100, 1)}%"})

    amount_field = mapping.get("amount")
    numeric_summaries = []
    if amount_field:
        raw_amount = df[amount_field]
        amounts = pd.to_numeric(raw_amount, errors="coerce")
        invalid = int((~blank_mask[amount_field] & amounts.isna()).sum())
        negative = int((amounts < 0).sum())
        valid = amounts.dropna()
        if not valid.empty:
            total = float(valid.sum())
            metrics.append({"key": "amount", "label": "金额合计", "value": _display_number(total), "detail": f"均值 {_display_number(float(valid.mean()))}"})
            numeric_summaries.append({
                "field": amount_field,
                "total": round(total, 2),
                "average": round(float(valid.mean()), 2),
                "minimum": round(float(valid.min()), 2),
                "maximum": round(float(valid.max()), 2),
            })
        if invalid:
            anomalies.append({"severity": "danger", "title": f"{amount_field} 含非数字内容", "detail": f"{invalid} 行无法作为金额计算", "count": invalid, "field": amount_field})
        if negative:
            anomalies.append({"severity": "warning", "title": f"{amount_field} 出现负数", "detail": f"{negative} 行金额小于 0", "count": negative, "field": amount_field})

    tracking_field = mapping.get("tracking")
    if tracking_field:
        tracking = df.loc[~blank_mask[tracking_field], tracking_field].astype(str)
        repeated = int(tracking.duplicated(keep=False).sum())
        if repeated:
            anomalies.append({"severity": "danger", "title": "单号重复", "detail": f"{repeated} 行使用了重复单号", "count": repeated, "field": tracking_field})

    date_field = mapping.get("date")
    date_range = None
    if date_field:
        dates = pd.to_datetime(df[date_field], errors="coerce", format="mixed")
        valid_dates = dates.dropna()
        invalid_dates = int((~blank_mask[date_field] & dates.isna()).sum())
        if not valid_dates.empty:
            date_range = {
                "field": date_field,
                "start": valid_dates.min().strftime("%Y-%m-%d"),
                "end": valid_dates.max().strftime("%Y-%m-%d"),
            }
        if invalid_dates:
            anomalies.append({"severity": "warning", "title": f"{date_field} 日期格式异常", "detail": f"{invalid_dates} 行无法识别为日期", "count": invalid_dates, "field": date_field})

    distribution_fields = []
    for key in ("status", "customer", "route"):
        field = mapping.get(key)
        if field and field not in distribution_fields:
            distribution_fields.append(field)
    if not distribution_fields:
        distribution_fields = [column for column, kind in kinds.items() if kind == "categorical"][:2]

    distributions = []
    for field in distribution_fields[:3]:
        counts = df.loc[~blank_mask[field], field].astype(str).value_counts().head(6)
        total = int(counts.sum()) or 1
        distributions.append({
            "field": field,
            "items": [
                {"label": str(label), "count": int(count), "percent": round(int(count) / total * 100, 1)}
                for label, count in counts.items()
            ],
        })

    mapping_text = "、".join(f"{MAPPING_LABELS.get(key, key)}={value}" for key, value in mapping.items())
    summary_parts = [f"{source_name} 共 {row_count} 条记录、{column_count} 个字段，完整率 {completeness}%"]
    if anomalies:
        summary_parts.append(f"发现 {len(anomalies)} 类需要复核的问题")
    else:
        summary_parts.append("未发现明显的数据质量问题")
    if mapping_text:
        summary_parts.append(f"字段映射：{mapping_text}")

    sample_rows = []
    for _, row in df.head(8).iterrows():
        sample_rows.append({column: (None if pd.isna(value) else _cell_value(value)) for column, value in row.items()})

    return {
        "sourceName": source_name,
        "rows": row_count,
        "columnCount": column_count,
        "completeness": completeness,
        "missingCells": missing_cells,
        "duplicateRows": duplicate_rows,
        "columns": profiles,
        "metrics": metrics,
        "numericSummaries": numeric_summaries,
        "distributions": distributions,
        "anomalies": anomalies,
        "dateRange": date_range,
        "sampleRows": sample_rows,
        "summary": "；".join(summary_parts) + "。",
    }
