# HT Logistic Workspace

HT Logistic Workspace 是一个面向物流日常工作的本地 AI 工作台。把「单据制作」「Excel 数据分析」「AI 助手」「本地文件查看」放在同一个客户端页面里，减少在工具、文件和会话之间来回切换。打包成傻瓜安装包后，用户无需预装 Node.js / Python / Rust 即可使用。

## 当前定位

- 日常单据制作：发票/箱单生成，基于 Excel 数据源和模板批量输出文件。
- 物流数据分析：上传 Excel/CSV，自动生成统计、分布、Top 频次、相关性等 JSON 报告，并可交给助手解读。
- AI 助手：Tauri 主进程启动 Pi RPC，前端提供会话、模型、权限、工具调用入口。
- 三栏工作台：第一栏切换 AI 助手、业务工具和模型；第二栏根据当前模式显示历史对话、项目文件或最近输出；第三栏专注当前任务。
- 本地文件管理：项目文件固定在左侧上下文栏，可直接加入 AI 对话或交给物流工具处理。
- 傻瓜包分发：一键构建 NSIS 安装包，内嵌 Python sidecar + 便携 Node.js + Pi，新电脑装完即用。
- 自动更新：基于 Tauri updater + GitHub Release，支持版本检查、下载、签名校验、自动安装。

## 技术架构

```text
Tauri v2 desktop app
  ├─ React + Vite frontend
  │   ├─ AI chat / session list / composer
  │   ├─ logistics tools panel
  │   ├─ file browser sidebar
  │   └─ settings (model config / system prompt / update)
  ├─ Rust main process
  │   ├─ starts Pi in RPC mode (from bundled pi-runtime.7z)
  │   ├─ scans Pi session files
  │   ├─ manages model config and agent files
  │   ├─ starts Python sidecar (with health check)
  │   ├─ test_model_connection (validates API keys)
  │   └─ open_update_folder (finds downloaded setup.exe)
  ├─ Python sidecar (FastAPI on 127.0.0.1:8000)
  │   ├─ invoice / packing generation
  │   ├─ customs tools
  │   └─ Excel data analysis
  └─ Pi runtime (bundled, extracted to %LOCALAPPDATA%)
      └─ registers logistic_* tools that call the sidecar
```

## 三栏交互

- AI 助手：第二栏默认显示历史对话，可切换到工作文件并把文件加入当前会话。
- 业务工具：第二栏显示项目文件和最近输出，第三栏显示当前工具的执行界面。
- 模型与状态：模型切换、Pi/Sidecar 在线状态和设置固定在第一栏底部。
- 上下文联动：从文件栏选择“加入聊天”会回到 AI 助手；执行单据或分析工具会自动切到对应工具。

## 目录结构

```text
tauri-app/                  Tauri + React 客户端
  src-tauri/
    src/main.rs             Rust 主进程（Pi/sidecar/命令）
    installer-hooks.nsh     NSIS 安装前钩子（杀残留进程）
    tauri.conf.json         Tauri 配置（resources/updater/signing）
    Cargo.toml              Rust 依赖
  src/                      React 前端
python-sidecar/             FastAPI 工具服务和物流工具实现
pi-extensions/              Pi all-in-one extension 和安装脚本
pi-agent-config/            Pi SYSTEM.md 与 skills 配置
scripts/
  build-installer.ps1       构建安装包（PyInstaller + pi-runtime.7z + NSIS）
  build-and-release.ps1     一键构建 + 版本 bump + GitHub Release
  install-python.ps1        Python 环境安装
dev.ps1                     一键开发启动脚本
deploy.ps1                  安装/部署/验证脚本
CODEX_SUMMARY.md            项目摘要
PROJECT_HANDOFF.md          给后续代码模型接手的详细上下文
```

## 傻瓜包打包

一键构建 Windows NSIS 安装包，新电脑装完即用，无需预装任何运行时。

```powershell
# 前置：Rust + Node.js + Python + 签名密钥（C:\Users\HT\.tauri\ht-logistic.key）
.\scripts\build-and-release.ps1
```

构建流程：
1. PyInstaller 把 Python sidecar 打成单文件 `ht-sidecar.exe`（含完整 Python 运行时）
2. 下载便携版 Node.js + npm install `@earendil-works/pi-coding-agent` → 压缩为 `pi-runtime.7z`
3. Tauri build 把 `ht-sidecar.exe` + `pi-runtime.7z` 作为 resources 打入安装包
4. NSIS 生成 `HT Logistic Agent_x.x.x_x64-setup.exe` + `.sig` + `latest.json`
5. 自动创建 GitHub Release 并上传 3 个文件

**关键设计**：
- `pi-runtime.7z` 压缩为单文件，绕过 NSIS MAX_PATH 260 字符限制（@mistralai 深层嵌套路径）
- 首次启动时 Rust 用 `sevenz-rust2` 解压 7z 到 `%LOCALAPPDATA%\ht-logistic\pi-runtime\`
- NSIS 安装前钩子 `taskkill` 残留进程，避免 "无法打开要写入的文件 ht-sidecar" 错误

## 自动更新

- 更新源：GitHub Release 的 `latest.json`
- 触发方式：设置页手动检查（不做启动时自动检查）
- 签名校验：构建时用 `TAURI_SIGNING_PRIVATE_KEY` 签名，更新时用 pubkey 校验
- 安装失败处理：设置页提供"打开更新文件夹"按钮，定位已下载的 setup.exe 手动重装

`latest.json` 构建后由脚本自动修正：
- url 用 GitHub asset 实际名（空格→点）
- signature 从 `.sig` 文件读取（保证与 setup.exe 匹配）

## 模型配置

设置页可配置多个 LLM provider，填入 API Key 后注入环境变量供 Pi 读取。每个 provider 支持"测试连接"——发 `max_tokens=1` 的最小请求验证 key 是否有效。

支持的 provider（默认模型已按官方文档更新）：

| Provider | 默认模型 | base_url |
|----------|---------|----------|
| DeepSeek | deepseek-v4-flash | https://api.deepseek.com |
| OpenAI | gpt-4.1 | https://api.openai.com |
| Anthropic | claude-sonnet-4-5-20250929 | https://api.anthropic.com |
| Google Gemini | gemini-2.5-flash | https://generativelanguage.googleapis.com |
| OpenRouter | anthropic/claude-sonnet-4.5 | https://openrouter.ai/api/v1 |

配置文件：`~/.pi/agent/model-config.json`

## 开发启动

首次准备 Python sidecar：

```powershell
cd python-sidecar
.\setup.ps1
```

安装 Pi 扩展和 agent 配置：

```powershell
cd pi-extensions
.\install.ps1
```

启动开发环境：

```powershell
.\dev.ps1
```

也可以分别启动：

```powershell
cd python-sidecar
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000

cd ..\tauri-app
npm install
npm run tauri dev
```

## 常用命令

```powershell
cd tauri-app
npm run build
npm run test
```

验证 sidecar：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
Invoke-RestMethod http://127.0.0.1:8000/api/tools
```

一键部署与验证：

```powershell
.\deploy.ps1
```

## 当前可用工具

Python sidecar 暴露 4 个接口：

| ID | 名称 | 输入 | 输出 | 前端展示 |
|---|---|---|---|---|
| `invoice-packing` | 发票/箱单生成 | Excel | ZIP | 是 |
| `data-analysis` | Excel 数据分析 | Excel/CSV | JSON | 是 |
| `customs-generator` | 报关箱单生成 | Excel | ZIP | 暂不优先展示 |
| `customs-extractor` | 报关单信息提取 | PDF | Excel | 暂不优先展示 |

Pi 扩展中对应注册：

- `logistic_invoice_packing`
- `logistic_data_analysis`
- `logistic_customs_generator`
- `logistic_customs_extractor`
- `logistic_list_tools`

## UI 方向

当前主界面按 Codex 风格调整为：

- 左侧：会话列表，按项目名分组。
- 中间：`Logistic Workspace` 空状态、居中聊天框、模型/权限/工具快捷入口。
- 下方：物流工具区，优先单据制作和数据分析。
- 右侧：文件浏览器侧栏。
- 设置面板：模型配置（含测试连接）、系统提示词、外观、关于与更新。

后续 UI 优先继续围绕「物流工作台」而不是通用聊天机器人扩展。

## 重要说明

- Python sidecar 默认端口固定为 `127.0.0.1:8000`，启动后通过 HTTP `/api/health` 健康检查。
- Pi 由 Tauri 主进程启动，Python sidecar 不负责启动 Pi，避免多进程抢会话。
- 窗口关闭时同时清理 Pi 和 sidecar 子进程，避免残留进程锁文件。
- 本地模型/API Key 配置写入 `~/.pi/agent/model-config.json`，启动时注入进程环境变量。
- 模板文件依赖在 `python-sidecar/tools/` 内部逻辑中，新增模板时优先保持工具函数纯输入/输出。
- 打包后的 pi-runtime 解压到 `%LOCALAPPDATA%\ht-logistic\pi-runtime\`（用户可写，路径短）。

更多接手细节见 [PROJECT_HANDOFF.md](./PROJECT_HANDOFF.md) 和 [CODEX_SUMMARY.md](./CODEX_SUMMARY.md)。
