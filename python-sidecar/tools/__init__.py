# 工具层：每个工具一个独立模块。
# 设计原则：
#   - 每个工具是一个纯函数：输入数据 → 输出数据/文件
#   - 不依赖 FastAPI（方便单独测试和被 Pi 扩展调用）
#   - FastAPI 路由只是薄包装，把 HTTP 请求转成函数调用

from . import invoice_packing, customs_generator, customs_extractor, extract_customs

__all__ = ["invoice_packing", "customs_generator", "customs_extractor", "extract_customs"]
