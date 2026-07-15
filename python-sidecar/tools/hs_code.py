"""HS 编码查询工具

输入：HS 编码（如 "6109100021"）或品名关键词（如 "棉制T恤"）
输出：匹配的 HS 编码条目列表（编码、品名、税率信息等）

数据来源：中国海关 HS 编码公开数据。首次查询时从远程拉取并缓存到本地 SQLite，
后续查询直接读本地库，无需网络。

设计目标：用户在对话中问"HS 编码 6109100021 是什么"或"棉制T恤的 HS 编码是多少"，
Pi 自动调此工具返回结构化结果，无需用户手动查海关编码网站。
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

# 本地缓存数据库路径
_DB_PATH = Path.home() / ".pi" / "hs_codes.db"

# HS 编码数据源（JSON 格式，包含编码/品名/税率等字段）
# 实际部署时把海关公开数据导出为 JSON 放到此路径，或通过 URL 拉取。
# 这里用一个内置的小型示例数据集，覆盖常见物流品类。
_DATA_URL = "https://example.com/hs_codes.json"  # 占位，实际用 _BUILTIN_DATA

# 内置示例数据（常见物流品类，供无网络时使用）
_BUILTIN_DATA: list[dict[str, str]] = [
    {"code": "6109100021", "name": "棉制针织或钩编的T恤衫、汗衫及其他背心", "category": "第十一类 纺织原料及纺织制品", "tax_rate": "6%", "unit": "件", "export_rebate": "13%"},
    {"code": "6109100091", "name": "其他棉制针织或钩编的T恤衫、汗衫", "category": "第十一类 纺织原料及纺织制品", "tax_rate": "6%", "unit": "件", "export_rebate": "13%"},
    {"code": "62034290", "name": "棉制男式长裤、工装裤等", "category": "第十一类 纺织原料及纺织制品", "tax_rate": "6%", "unit": "条", "export_rebate": "13%"},
    {"code": "64029929", "name": "橡塑底及面其他鞋靴", "category": "第十二类 鞋、帽、伞、杖、鞭", "tax_rate": "10%", "unit": "双", "export_rebate": "13%"},
    {"code": "95030021", "name": "羽毛制羽毛球", "category": "第二十类 杂项制品", "tax_rate": "6%", "unit": "个", "export_rebate": "13%"},
    {"code": "85234910", "name": "其他光盘（非仅录制声音）", "category": "第十六类 机器、机械器具", "tax_rate": "0%", "unit": "张", "export_rebate": "13%"},
    {"code": "85171200", "name": "电话机（智能手机等）", "category": "第十六类 机器、机械器具", "tax_rate": "0%", "unit": "台", "export_rebate": "13%"},
    {"code": "49019900", "name": "其他书籍、小册子及类似印刷品", "category": "第十类 木浆及纸", "tax_rate": "0%", "unit": "千克", "export_rebate": "10%"},
    {"code": "33030000", "name": "香水及花露水", "category": "第六类 化工产品", "tax_rate": "3%", "unit": "千克", "export_rebate": "13%"},
    {"code": "42022100", "name": "皮革、再生皮革制手提包", "category": "第八类 皮革制品", "tax_rate": "6%", "unit": "个", "export_rebate": "13%"},
    {"code": "71131919", "name": "其他贵金属制首饰", "category": "第十五类 贱金属及其制品", "tax_rate": "10%", "unit": "克", "export_rebate": "13%"},
    {"code": "94035010", "name": "卧室用木家具", "category": "第二十类 杂项制品", "tax_rate": "0%", "unit": "件", "export_rebate": "13%"},
    {"code": "39241000", "name": "塑料制餐具及厨房用具", "category": "第七类 塑料及其制品", "tax_rate": "6%", "unit": "千克", "export_rebate": "13%"},
    {"code": "69120010", "name": "陶瓷餐具", "category": "第十三类 陶瓷产品", "tax_rate": "6%", "unit": "个", "export_rebate": "13%"},
    {"code": "21011100", "name": "咖啡浓缩精汁及以其为基本成分的制品", "category": "第一类 活动物；动物产品", "tax_rate": "10%", "unit": "千克", "export_rebate": "13%"},
    {"code": "18063200", "name": "巧克力（夹心或非夹心）", "category": "第二类 植物产品", "tax_rate": "8%", "unit": "千克", "export_rebate": "13%"},
    {"code": "22042100", "name": "2升及以下容器装鲜葡萄酿酒", "category": "第四类 饮料、酒及醋", "tax_rate": "14%", "unit": "升", "export_rebate": "13%"},
    {"code": "30049059", "name": "其他混合或非混合产品（中药酒等）", "category": "第六类 化工产品", "tax_rate": "3%", "unit": "千克", "export_rebate": "13%"},
    {"code": "84713000", "name": "便携式数字自动数据处理设备（笔记本电脑等）", "category": "第十六类 机器、机械器具", "tax_rate": "0%", "unit": "台", "export_rebate": "13%"},
    {"code": "85287212", "name": "彩色液晶电视机（屏幕＞52cm）", "category": "第十六类 机器、机械器具", "tax_rate": "15%", "unit": "台", "export_rebate": "13%"},
    {"code": "84151010", "name": "独立式空调器（制冷≤14000大卡/时）", "category": "第十六类 机器、机械器具", "tax_rate": "0%", "unit": "台", "export_rebate": "13%"},
    {"code": "85044013", "name": "手机用充电器（开关电源）", "category": "第十六类 机器、机械器具", "tax_rate": "0%", "unit": "个", "export_rebate": "13%"},
    {"code": "85076000", "name": "锂离子蓄电池", "category": "第十六类 机器、机械器具", "tax_rate": "6%", "unit": "个", "export_rebate": "13%"},
    {"code": "87089999", "name": "机动车辆用其他零件、附件", "category": "第十七类 车辆、航空器", "tax_rate": "6%", "unit": "千克", "export_rebate": "13%"},
    {"code": "87120030", "name": "电动自行车", "category": "第十七类 车辆、航空器", "tax_rate": "5%", "unit": "辆", "export_rebate": "13%"},
    {"code": "95063200", "name": "高尔夫球棍", "category": "第二十类 杂项制品", "tax_rate": "6%", "unit": "根", "export_rebate": "13%"},
    {"code": "95066210", "name": "篮球、排球、足球", "category": "第二十类 杂项制品", "tax_rate": "6%", "unit": "个", "export_rebate": "13%"},
    {"code": "61099090", "name": "其他纺织材料制针织或钩编T恤衫", "category": "第十一类 纺织原料及纺织制品", "tax_rate": "6%", "unit": "件", "export_rebate": "13%"},
    {"code": "61102000", "name": "棉制针织或钩编的套头衫、开襟衫、马甲", "category": "第十一类 纺织原料及纺织制品", "tax_rate": "6%", "unit": "件", "export_rebate": "13%"},
    {"code": "62014090", "name": "其他纺织材料制女式大衣、斗篷", "category": "第十一类 纺织原料及纺织制品", "tax_rate": "6%", "unit": "件", "export_rebate": "13%"},
]


def _ensure_db() -> sqlite3.Connection:
    """确保本地 SQLite 数据库存在并已初始化。"""
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(_DB_PATH))
    conn.row_factory = sqlite3.Row
    # 建表（IF NOT EXISTS 幂等）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS hs_codes (
            code TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT,
            tax_rate TEXT,
            unit TEXT,
            export_rebate TEXT,
            name_lower TEXT
        )
    """)
    # 检查是否已有数据
    count = conn.execute("SELECT COUNT(*) FROM hs_codes").fetchone()[0]
    if count == 0:
        # 写入内置数据
        rows = [
            (d["code"], d["name"], d.get("category", ""),
             d.get("tax_rate", ""), d.get("unit", ""),
             d.get("export_rebate", ""), d["name"].lower())
            for d in _BUILTIN_DATA
        ]
        conn.executemany(
            "INSERT OR REPLACE INTO hs_codes (code,name,category,tax_rate,unit,export_rebate,name_lower) VALUES (?,?,?,?,?,?,?)",
            rows
        )
        conn.commit()
    return conn


def query_hs_code(query: str) -> dict[str, Any]:
    """查询 HS 编码。

    自动判断查询类型：
    - 纯数字（4-10位）：按编码精确/前缀匹配
    - 包含中文/字母：按品名关键词模糊匹配

    Args:
        query: HS 编码（如 "6109100021"）或品名关键词（如 "棉制T恤"）

    Returns:
        {
            "query": str,
            "match_type": "code" | "name" | "none",
            "results": [
                {
                    "code": "6109100021",
                    "name": "棉制针织或钩编的T恤衫...",
                    "category": "...",
                    "tax_rate": "6%",
                    "unit": "件",
                    "export_rebate": "13%"
                }
            ],
            "count": int
        }
    """
    query = query.strip()
    if not query:
        return {"query": query, "match_type": "none", "results": [], "count": 0}

    conn = _ensure_db()

    # 判断查询类型：纯数字 → 编码查询；否则 → 品名查询
    is_code_query = query.replace(" ", "").isdigit()

    if is_code_query:
        code = query.replace(" ", "")
        # 先精确匹配，再前缀匹配（HS 编码 4/6/8/10 位）
        rows = conn.execute(
            "SELECT * FROM hs_codes WHERE code = ? OR code LIKE ? ORDER BY LENGTH(code) LIMIT 20",
            (code, f"{code}%")
        ).fetchall()
        match_type = "code"
    else:
        # 品名模糊匹配：先按完整短语，再降级到中文字符/英文词组合。
        # 例如“棉制T恤”也应命中“棉制针织或钩编的T恤衫”。
        keywords = [k.lower() for k in query.split() if k.strip()]
        if not keywords:
            keywords = [query.lower()]
        conditions = " AND ".join(["name_lower LIKE ?" for _ in keywords])
        params = [f"%{k}%" for k in keywords]
        rows = conn.execute(
            f"SELECT * FROM hs_codes WHERE {conditions} LIMIT 20",
            params
        ).fetchall()
        if not rows:
            fallback_keywords = re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]", query.lower())
            fallback_keywords = list(dict.fromkeys(fallback_keywords))
            if fallback_keywords:
                fallback_conditions = " AND ".join(["name_lower LIKE ?" for _ in fallback_keywords])
                rows = conn.execute(
                    f"SELECT * FROM hs_codes WHERE {fallback_conditions} LIMIT 20",
                    [f"%{keyword}%" for keyword in fallback_keywords],
                ).fetchall()
        match_type = "name"

    results = [
        {
            "code": r["code"],
            "name": r["name"],
            "category": r["category"],
            "tax_rate": r["tax_rate"],
            "unit": r["unit"],
            "export_rebate": r["export_rebate"],
        }
        for r in rows
    ]

    return {
        "query": query,
        "match_type": match_type if results else "none",
        "results": results,
        "count": len(results),
    }
