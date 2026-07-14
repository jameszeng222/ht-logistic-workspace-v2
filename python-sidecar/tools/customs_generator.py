"""报关箱单生成

重构自原始脚本 `generate_customs_files.py`。
原脚本问题：硬编码本地文件路径 + 顶层执行 + input() 阻塞。
重构后：数据源从上传 bytes 读取，输出 {文件名: bytes} 字典。

业务逻辑：
  数据源.xlsx（Sheet1/亚马逊/XC/新流程 4 sheet）
  → 按"入库单号"分组，处理合并报关
  → 按 FBA/WI/合并 三种情况输出 Excel
"""

from __future__ import annotations

import io

import pandas as pd


def _process_volume_column(data: pd.DataFrame) -> pd.DataFrame:
    """处理方数列，只保留总方数（第一个非空值）。"""
    if "方数" in data.columns:
        total_volume = None
        for val in data["方数"]:
            if pd.notna(val) and val != 0:
                total_volume = val
                break
        data["方数"] = [total_volume if i == 0 else None for i in range(len(data))]
    return data


def generate_customs_files(data_source_bytes: bytes) -> dict[str, bytes]:
    """主入口：数据源 Excel bytes → {文件名: Excel bytes}。

    业务逻辑（保持与原脚本一致）：
      1. 读取 4 个 sheet
      2. 从 Sheet1 找"合并报关"分组
      3. 遍历 Sheet1 每行，按 FBA/WI/合并报关 三种情况输出
    """
    xls = pd.ExcelFile(io.BytesIO(data_source_bytes))
    sheet1 = xls.parse("Sheet1")
    amazon_df = xls.parse("亚马逊")
    xc_df = xls.parse("XC")
    new_process_df = xls.parse("新流程")

    # 1. 找合并报关分组
    merged_groups: dict[str, dict] = {}
    for idx, row in sheet1.iterrows():
        customs_detail = str(row["报关详情"]).strip() if pd.notna(row["报关详情"]) else ""
        if "合并报关" not in customs_detail:
            continue
        main_order_no = str(row["入库单号/入仓编码"]).strip()
        logistics = str(row["物流商"]).strip() if pd.notna(row["物流商"]) else ""
        if idx + 1 < len(sheet1):
            next_row = sheet1.iloc[idx + 1]
            next_order_no = str(next_row["入库单号/入仓编码"]).strip()
            next_customs = str(next_row["报关详情"]).strip() if pd.notna(next_row["报关详情"]) else ""
            if pd.isna(next_row["报关详情"]) or next_customs == "":
                merged_groups[main_order_no] = {
                    "second": next_order_no,
                    "customs": customs_detail,
                    "logistics": logistics,
                }

    # 2. 遍历生成
    results: dict[str, bytes] = {}
    processed_rows: set[int] = set()

    for idx, row in sheet1.iterrows():
        order_no = str(row["入库单号/入仓编码"]).strip()
        file_name = str(row["命名"]).strip()
        if pd.isna(order_no) or order_no == "nan" or pd.isna(file_name) or file_name == "nan":
            continue
        if idx in processed_rows:
            continue

        def _save(df: pd.DataFrame, name: str) -> None:
            df = _process_volume_column(df)
            buf = io.BytesIO()
            df.to_excel(buf, index=False, sheet_name="Sheet1")
            results[f"{name}.xlsx"] = buf.getvalue()

        # 合并报关
        if order_no in merged_groups:
            g = merged_groups[order_no]
            second = g["second"]
            merged_name = f"{order_no}、{second}--{g['customs']}--{g['logistics']}"
            data1 = new_process_df[new_process_df["万邑通单号"] == order_no].copy()
            data2 = new_process_df[new_process_df["万邑通单号"] == second].copy()
            if len(data1) > 0 or len(data2) > 0:
                merged = pd.concat([data1, data2], ignore_index=True)
                _save(merged, merged_name)
                processed_rows.add(idx + 1)

        elif order_no.startswith("FBA"):
            data = amazon_df[amazon_df["万邑通单号"] == order_no].copy()
            if len(data) > 0:
                _save(data, file_name)

        elif order_no.startswith("WI"):
            xc_match = xc_df[xc_df["第三方入库单号"] == order_no]
            np_match = new_process_df[new_process_df["万邑通单号"] == order_no]
            if len(xc_match) > 0:
                _save(xc_match.copy(), file_name)
            elif len(np_match) > 0:
                _save(np_match.copy(), file_name)

    return results
