"""HT Logistic Workspace — 工具层 HTTP 入口

只负责工具（发票/箱单/报关单）调用，不碰 Pi。
Pi 由 Tauri 主进程直接管理（src-tauri/src/main.rs 的 start_pi），
避免两个进程同时拉起 Pi 造成会话/状态冲突。

启动（开发）：
    cd python-sidecar
    uvicorn main:app --reload --port 8000

启动（生产，PyInstaller 打包后）：
    ht-sidecar.exe   # 监听 127.0.0.1:8000
"""

from __future__ import annotations

import io
import zipfile

from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Query
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from tools import invoice_packing, customs_generator, customs_extractor, data_analysis, hs_code, logistics_data


app = FastAPI(title="HT Logistic Workspace — Tools")


class LogisticsDataRequest(BaseModel):
    values: list[list[object]] = Field(default_factory=list)
    mapping: dict[str, str] = Field(default_factory=dict)
    source_name: str = "飞书表格"

# Tauri 前端跑在 http://tauri.localhost，开发态跑在 http://localhost:5173，
# 都需要能调本服务。允许所有 origin 简化开发，生产部署仅本机访问无安全风险。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============ 工具发现 ============

@app.get("/api/tools")
async def list_tools():
    """列出所有可用工具（前端工具区渲染 + Pi 扩展发现都用这个）。"""
    return {"tools": [
        {
            "id": "invoice-packing",
            "name": "发票/箱单生成",
            "description": "上传数据源.xlsx，按万邑通单号生成发票+箱单（德速/联宇模板）",
            "endpoint": "/api/tools/invoice-packing",
            "input": "excel",
            "output": "zip",
        },
        {
            "id": "customs-generator",
            "name": "报关箱单生成",
            "description": "上传数据源.xlsx，按 FBA/WI/合并报关 三种情况生成报关箱单",
            "endpoint": "/api/tools/customs-generator",
            "input": "excel",
            "output": "zip",
        },
        {
            "id": "customs-extractor",
            "name": "报关单信息提取",
            "description": "上传报关单 PDF，OCR+正则提取关键字段（发货人/申报号/HS编码等）",
            "endpoint": "/api/tools/customs-extractor",
            "input": "pdf",
            "output": "excel",
        },
        {
            "id": "data-analysis",
            "name": "Excel 数据分析",
            "description": "上传 Excel/CSV，自动按列类型统计（数值/分类/时间）+ 相关性 + 直方图",
            "endpoint": "/api/tools/data-analysis",
            "input": "excel",
            "output": "json",
        },
        {
            "id": "hs-code",
            "name": "HS 编码查询",
            "description": "输入 HS 编码或品名关键词，查询编码/品名/税率/计量单位/出口退税率",
            "endpoint": "/api/tools/hs-code?q=",
            "input": "text",
            "output": "json",
        },
    ]}


@app.get("/api/health")
async def health():
    """健康检查，Tauri 启动 sidecar 后轮询此接口确认服务就绪。"""
    return {"ok": True}


@app.post("/api/logistics-data/analyze")
async def analyze_logistics_data(request: LogisticsDataRequest):
    """Analyze tabular values after Tauri securely retrieves them from Feishu."""
    try:
        return logistics_data.analyze_values(request.values, request.mapping, request.source_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"分析失败：{e}")


# ============ 工具实现 ============

def _make_zip(files: dict[str, bytes]) -> bytes:
    """把 {文件名: bytes} 打包成 zip bytes。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


@app.post("/api/tools/invoice-packing")
async def gen_invoice_packing(file: UploadFile = File(...)):
    """发票/箱单生成：上传数据源.xlsx → 返回 zip（含多个 Excel）。"""
    content = await file.read()
    try:
        files = invoice_packing.generate_invoice_packing(content)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=f"模板文件缺失：{e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"处理失败：{e}")
    if not files:
        raise HTTPException(status_code=400, detail="未从数据源提取到任何单号")
    zip_bytes = _make_zip(files)
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=invoice-packing.zip"},
    )


@app.post("/api/tools/customs-generator")
async def gen_customs_files(file: UploadFile = File(...)):
    """报关箱单生成：上传数据源.xlsx → 返回 zip。"""
    content = await file.read()
    try:
        files = customs_generator.generate_customs_files(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"处理失败：{e}")
    if not files:
        raise HTTPException(status_code=400, detail="未从数据源提取到任何单号")
    zip_bytes = _make_zip(files)
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=customs-files.zip"},
    )


@app.post("/api/tools/customs-extractor")
async def extract_customs(file: UploadFile = File(...)):
    """报关单提取：上传 PDF → 返回 Excel。"""
    content = await file.read()
    try:
        result = customs_extractor.extract_customs_data(content, file.filename or "upload.pdf")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"处理失败：{e}")
    if not result["excel"]:
        raise HTTPException(status_code=400, detail="未从 PDF 提取到任何报关单数据")
    return Response(
        content=result["excel"],
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=customs-extracted.xlsx"},
    )


@app.post("/api/tools/data-analysis")
async def analyze_data(
    file: UploadFile = File(...),
    input_format: str = Form("auto"),
    output_format: str = Form("report"),
    header_row: int = Form(1),
    sheet_name: str = Form(""),
    template: UploadFile | None = File(None),
):
    """按指定结构读取 Excel/CSV，并返回在线报告或可保存文件。"""
    content = await file.read()
    try:
        options = {
            "input_format": input_format,
            "header_row": header_row,
            "sheet_name": sheet_name,
        }
        if output_format == "report":
            return data_analysis.analyze_excel_data(content, file.filename or "upload.xlsx", **options)
        template_content = await template.read() if template is not None else None
        result = data_analysis.export_data(
            content,
            file.filename or "upload.xlsx",
            output_format=output_format,
            template_data=template_content,
            **options,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"分析失败：{e}")
    media_type = "text/csv; charset=utf-8" if output_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    extension = "csv" if output_format == "csv" else "xlsx"
    return Response(
        content=result,
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename=data-analysis.{extension}"},
    )


@app.post("/api/tools/data-analysis/preview")
async def preview_data(
    file: UploadFile = File(...),
    input_format: str = Form("auto"),
    header_row: int = Form(1),
    sheet_name: str = Form(""),
    template: UploadFile | None = File(None),
):
    """执行前识别字段、空值，并检查输入字段与输出模板是否匹配。"""
    content = await file.read()
    template_content = await template.read() if template is not None else None
    try:
        return data_analysis.preview_excel_data(
            content,
            file.filename or "upload.xlsx",
            input_format=input_format,
            header_row=header_row,
            sheet_name=sheet_name,
            template_data=template_content,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"检查失败：{e}")


@app.get("/api/tools/hs-code")
async def query_hs_code(q: str = Query(..., description="HS 编码或品名关键词")):
    """HS 编码查询：输入编码或品名 → 返回匹配的 HS 编码条目。

    与其他工具不同，此端点是 GET 请求（无需上传文件），
    参数 q 可为 HS 编码（纯数字）或品名关键词。
    """
    try:
        result = hs_code.query_hs_code(q)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"查询失败：{e}")
    return result


if __name__ == "__main__":
    # PyInstaller 打包后用 python main.py 直接跑（无 uvicorn CLI 时）。
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
