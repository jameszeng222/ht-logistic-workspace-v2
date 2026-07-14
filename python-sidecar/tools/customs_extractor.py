"""报关单信息提取（封装层）

封装原始 `extract_customs.py`，提供可被 FastAPI 调用的接口：
  - 输入：PDF bytes + 文件名（用于推断万邑通单号）
  - 输出：结构化数据列表 + Excel bytes

不改动 extract_customs.py 的复杂提取逻辑（1318 行，含 OCR），
仅通过临时文件方式桥接（原模块接受文件路径）。
"""

from __future__ import annotations

import io
import os
import tempfile

import pandas as pd

# 导入原始模块（同目录下）
from . import extract_customs


def extract_customs_data(pdf_bytes: bytes, file_name: str = "upload.pdf") -> dict:
    """从报关单 PDF bytes 提取结构化数据。

    Args:
        pdf_bytes: PDF 文件内容
        file_name: 原始文件名（用于从文件名提取万邑通单号 WI/FBA）

    Returns:
        {
            "records": [{...}, ...],  # 提取的报关单字段
            "excel": b"...",          # 结果 Excel bytes
            "count": int,             # 提取行数
        }
    """
    # 原模块接受文件路径，写临时文件桥接
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name

    try:
        # 原模块用 os.path.basename 取文件名提取单号，故把临时文件名改成上传文件名
        dir_name = os.path.dirname(tmp_path)
        named_path = os.path.join(dir_name, file_name)
        os.rename(tmp_path, named_path)
        tmp_path = named_path

        records = extract_customs.extract_single_pdf(tmp_path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

    if not records:
        return {"records": [], "excel": None, "count": 0}

    df = pd.DataFrame(records)
    buf = io.BytesIO()
    df.to_excel(buf, index=False)
    return {
        "records": records,
        "excel": buf.getvalue(),
        "count": len(records),
    }
