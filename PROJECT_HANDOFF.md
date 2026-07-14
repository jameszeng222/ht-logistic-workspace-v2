# HT Logistic Workspace 项目交接说明

本文档用于把项目交给 Trae 或其他代码模型继续开发。它比 README 更偏工程上下文、产品方向和改造建议。

## 1. 项目一句话

HT Logistic Workspace 是一个本地桌面物流 AI 工作台，用 Tauri + React 做客户端，用 Rust 管 Pi RPC 和本地文件/会话，用 Python FastAPI sidecar 承载 Excel/PDF 物流工具，用 Pi extension 把工具暴露给 AI agent 调用。

当前用户方向非常明确：不要做成泛 AI 聊天页面，要做成「物流工具 + AI 助手 + 文件侧栏」同屏工作台。高频业务是单据制作和数据分析，报关处理暂时不是重点。

## 2. 当前产品形态

主页面是三栏布局：

- 左侧：会话管理。当前按项目名分组，不按完整目录分组。已删除会话分支入口和 Fork 入口。
- 中间：AI 助手。空状态标题为 `Logistic Workspace`，聊天框居中偏上，聊天框里包含模型切换、权限切换、单据制作、数据分析、工具调用快捷按钮。
- 中间下方：物流工具区。现在优先展示 `invoice-packing` 和 `data-analysis`，工具执行结果可发给助手解读。
- 右侧：文件浏览器。用于查看当前会话/项目目录文件，和工具、助手在同一个页面。

视觉方向：参考 Codex/轻客户端风格，浅色默认，少分隔线，多用留白、圆角、hover 状态和轻阴影。

## 3. 技术栈

### 桌面客户端

- Tauri v2
- React 18
- Vite 5
- TypeScript
- Rust backend commands
- Tauri dialog/fs plugins

### 工具 sidecar

- Python 3.10+，推荐 3.11/3.12
- FastAPI
- pandas / openpyxl
- pdfplumber
- pytesseract + Pillow（图片型 PDF OCR 可选）

### Agent / Pi

- Pi 以 `pi --mode rpc` 由 Tauri Rust 主进程启动
- Pi extension 使用 `~/.pi/agent/extensions/all-in-one.ts`
- agent 配置部署到 `~/.pi/agent/SYSTEM.md` 和 `~/.pi/agent/skills/`

## 4. 关键目录与文件

```text
tauri-app/src/App.tsx
  主界面：会话管理、聊天、模型/权限、工具区、文件侧栏、设置弹窗。

tauri-app/src/ToolsPanel.tsx
  物流工具区：拉取 sidecar /api/tools，选择文件，调用工具，保存结果，发送结果给助手解读。

tauri-app/src/FileBrowser.tsx
  右侧文件浏览器。通过 Rust command list_dir/open_file/get_agent_paths 读本地目录。

tauri-app/src/styles.css
  全局 UI 样式。当前 Codex-like 布局和轻量视觉主要在这里。

tauri-app/src-tauri/src/main.rs
  Tauri Rust 主进程：
  - start_pi / stop_pi / send_command / send_request
  - scan_sessions / read_session_history / delete_session
  - model config 读写和 API Key 注入
  - Python sidecar 启动与状态
  - 文件浏览器命令
  - agent 文件读写

python-sidecar/main.py
  FastAPI 工具入口：
  - GET /api/health
  - GET /api/tools
  - POST /api/tools/invoice-packing
  - POST /api/tools/customs-generator
  - POST /api/tools/customs-extractor
  - POST /api/tools/data-analysis

python-sidecar/tools/
  物流工具实现。尽量保持工具函数为纯函数：输入 bytes，输出 bytes/JSON。

pi-extensions/all-in-one.ts
  Pi extension。注册 logistic_* 工具，并通过 HTTP 调 Python sidecar。

pi-agent-config/SYSTEM.md
  Pi agent 系统提示词和权限策略。
```

## 5. 当前已实现功能

### AI 助手

- Tauri 启动 Pi RPC 子进程。
- 前端监听 `pi-event`、`pi-stderr`。
- 支持流式消息、工具卡片、Markdown 渲染。
- 支持模型选择、模型配置保存、API Key 注入。
- 支持工具权限模式切换：标准权限 / 完全信任。
- 支持调试日志弹窗。

### 会话管理

- 扫描 Pi `.jsonl` 会话文件。
- 历史会话按项目名分组。
- 会话标题优先使用首条用户消息。
- 支持预览历史会话：点击历史会话只读历史，不立即切走 Pi 活动会话；发送新消息时才真正切换。
- 支持重命名、克隆、删除。
- 已移除页面上的分支导航和 Fork 入口，因为当前业务不需要。

### 物流工具区

- 从 sidecar 拉取工具列表。
- 当前前端优先显示：
  - 发票/箱单生成
  - Excel 数据分析
- 使用 Tauri 原生文件选择对话框读取本地文件。
- 文件型结果通过原生保存对话框落盘。
- JSON 型结果直接展示。
- 工具结果可一键发送给助手解读。

### 文件侧栏

- 同屏展示文件浏览器。
- 支持目录浏览、打开文件、在文件夹中显示。
- 默认定位当前会话 cwd 或 agent 相关路径。

### Pi 扩展

扩展中注册了物流工具：

- `logistic_invoice_packing`
- `logistic_data_analysis`
- `logistic_customs_generator`
- `logistic_customs_extractor`
- `logistic_list_tools`

扩展还包含一些通用工具：

- `chart_render`
- `kb_search`
- `http_request`
- `run_script`
- `query_database` / task / note 工具（依赖 `better-sqlite3`，安装失败时自动降级）
- `parse_pdf`（依赖 `pdf-parse`）

## 6. 当前业务优先级

用户明确说：

- 平时「单据制作」和「数据分析」多。
- 报关处理不需要作为当前重点。
- 助手和工具要放在同一个页面，不要切换页面。
- 工具区占比要更大。
- 会话管理要简单，像 Codex 按项目/文件工作区组织即可。
- UI 不要大量分隔线，视觉要像 Codex/轻客户端。

因此后续开发优先级建议如下：

1. 做强单据制作工具。
2. 做强 Excel 数据分析和可视化。
3. 让 AI 更好理解工具输出和当前文件。
4. 优化会话/文件/工具的联动。
5. 报关工具保留，但不要占主界面资源。

## 7. 建议下一步功能

### P0：让工具更像真正物流工作流

- 给 `invoice-packing` 增加字段校验报告：
  - 缺失万邑通单号
  - 缺失 SKU/品名/数量/单价
  - 单号重复
  - 渠道识别失败
- 输出前展示预检结果，用户确认后再生成。
- 执行结果返回结构化摘要，让助手能说明生成了哪些单、哪些失败、为什么失败。

### P0：增强数据分析

- `data-analysis` 输出目前是 JSON，下一步可以在前端直接渲染图表。
- 优先图表：
  - 数值列直方图
  - 分类 Top N 条形图
  - 时间列趋势图
  - 相关性热力图
- 让助手可读取分析 JSON 并生成业务建议。

### P1：文件侧栏和聊天联动

- 文件右键或按钮：发送给助手分析。
- 文件右键或按钮：用当前选中文件执行工具。
- 聊天框支持引用当前选中文件路径。
- 工具执行结果自动出现在文件侧栏/最近结果列表。

### P1：会话体验

- 支持项目工作区切换，而不是只靠历史会话 cwd。
- 左侧可以显示「当前项目」下最近会话。
- 新建会话时继承当前项目目录。
- 删除旧的 BranchNavigator 文件或隐藏到未来功能区，避免误导维护者。

### P1：模型与权限

- 聊天框里的模型切换已经有入口，但设置弹窗仍偏重。可做小型模型菜单。
- 权限模式可改成更清晰的 segmented control：
  - Standard
  - Full Trust
- 让权限说明更业务化，而不是技术化。

### P2：打包与安装

- 完善 PyInstaller sidecar 打包流程。
- Tauri 打包时把 `python-sidecar/ht-sidecar.exe` 放进 resources。
- 首次运行时检测 Python sidecar 是否就绪并给出明确修复按钮。

## 8. 重要设计约束

### 不要把工具区做成单独页面

用户明确希望助手和工具同屏。工具区在聊天框下面，侧栏文件在右侧。

### 不要恢复会话分支 UI

Pi 的 session tree/fork 能力在底层可能存在，但用户说对当前工作没用。主界面不要放分支导航。

### 不要让报关工具抢主界面

报关工具保留在后端和 extension 中即可。除非用户明确要求，否则前端工具区继续聚焦单据制作和数据分析。

### 不要让 UI 回到重分隔线风格

当前用户不喜欢大量分隔线。新增区域优先用背景层次、留白、轻边框、hover 状态。

### 不要让 Python sidecar 启动 Pi

Pi 由 Rust 主进程管理，sidecar 只负责工具 HTTP API。这样避免两个进程同时启动 Pi 导致状态和会话冲突。

## 9. 运行方式

首次安装 Python 依赖：

```powershell
cd python-sidecar
.\setup.ps1
```

安装 Pi extension：

```powershell
cd pi-extensions
.\install.ps1
```

开发启动：

```powershell
.\dev.ps1
```

客户端构建：

```powershell
cd tauri-app
npm run build
```

测试：

```powershell
cd tauri-app
npm run test
```

部署验证：

```powershell
.\deploy.ps1
```

## 10. 常见问题

### sidecar 不在线

检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

如果失败：

- 确认 `python-sidecar/.venv` 已创建。
- 确认没有其他程序占用 8000。
- 查看 `python-sidecar/.sidecar.err`。

### Python 依赖安装失败

优先使用 Python 3.11 或 3.12。Python 3.13+ 在 Windows 上可能缺少 pandas/numpy 等预编译 wheel。

### Pi 找不到

Rust `find_pi()` 会找 PATH 和 Windows npm 全局目录。需要确认已安装 Pi CLI，并且 `pi` 或 `pi.cmd` 可执行。

### better-sqlite3 安装失败

这是可选依赖。安装失败时 SQLite 相关工具会禁用，但物流工具不受影响。

## 11. 给 Trae 的修改提示词

可以直接把下面这段给 Trae：

```text
你在维护 HT Logistic Workspace。它是 Tauri v2 + React + Python FastAPI sidecar + Pi extension 的本地物流 AI 工作台。

产品方向：
- 助手、物流工具区、文件侧栏必须同屏。
- 高频业务是单据制作和 Excel 数据分析。
- 报关工具保留但不是主界面重点。
- UI 要接近 Codex/轻客户端风格：浅色、少分隔线、留白、轻边框。
- 会话管理按项目名分组，不要恢复分支导航和 Fork 入口。

关键文件：
- tauri-app/src/App.tsx：主界面和会话/chat 状态。
- tauri-app/src/ToolsPanel.tsx：工具区。
- tauri-app/src/FileBrowser.tsx：文件侧栏。
- tauri-app/src/styles.css：布局和视觉。
- tauri-app/src-tauri/src/main.rs：Pi RPC、sidecar、文件命令。
- python-sidecar/main.py 和 python-sidecar/tools/：物流工具 API。
- pi-extensions/all-in-one.ts：AI agent 可调用工具。

修改时请保持：
- Python sidecar 只做工具 API，不启动 Pi。
- 工具函数尽量输入 bytes、输出 bytes/JSON。
- 前端工具区默认只展示 invoice-packing 和 data-analysis。
- 构建验证至少运行：cd tauri-app && npm run build。
```

## 12. 当前仓库状态备注

最近主分支已合并 UI 改造：

- 首页标题：`Logistic Workspace`
- 删除空状态提示芯片
- 聊天框上移
- 工具区放大
- 会话按项目名分组
- 移除会话分支/Fork UI
- 当前会话统计去掉对话轮数和工具调用次数
- 减少主界面分隔线

后续最值得投入的是：把「工具执行结果」变成结构化业务反馈，再让 AI 能基于这些反馈给出可执行建议。
