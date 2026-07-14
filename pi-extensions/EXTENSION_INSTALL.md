# 扩展安装说明

本目录的 `all-in-one.ts` 是 Pi Assistant 的全场景扩展（数据分析 / 文档处理 / 自动化 / 任务笔记 / HT 物流，16 工具 / 5 域）。其中 HT 物流域的 5 个工具通过 HTTP 调用 Python sidecar（`python-sidecar/`，FastAPI on 127.0.0.1:8000），让 AI 能自主处理发票/箱单/报关单/数据分析。

## 为什么有 package.json

Pi 用 **jiti** 直接加载 TypeScript 扩展，**无需编译**。这里的 `package.json` 不是为了发布扩展，而是为了：

1. **固定原生依赖版本**（`better-sqlite3` / `pdf-parse`）以便复现安装；
2. 提供一个 `peerDependencies` 提示，说明扩展运行所需的 Pi 相关包（由 Pi 运行时提供，安装时无需在此安装）。

## 安装方式

扩展实际运行目录是 `~/.pi/agent/extensions/`（或 `$PI_AGENT_DIR/extensions/`）。请把 `all-in-one.ts` 拷过去后，**在该目录**安装依赖：

```bash
# 1. 拷贝扩展
cp all-in-one.ts ~/.pi/agent/extensions/all-in-one.ts

# 2. 进入扩展目录
cd ~/.pi/agent/extensions

# 3. 初始化并安装依赖（首次）
[ -f package.json ] || npm init -y
npm install better-sqlite3@^11.3.0 pdf-parse@^1.1.1
```

> 注：不要在本项目源码目录的 `pi-extensions/` 里 `npm install`，那不会影响 Pi 加载扩展时的依赖解析。Pi 在加载扩展时，Node 的模块查找会从扩展文件所在目录（`~/.pi/agent/extensions/`）向上查找 `node_modules`，所以依赖必须装在那里。

## 一键安装（推荐）

直接运行本目录的安装脚本，会自动完成上述全部步骤（拷贝扩展 + `npm init` + 装依赖到目标目录）：

```powershell
# Windows PowerShell（在 pi-extensions 目录下）
.\install.ps1
```

```bash
# macOS / Linux（手动执行上述三步，install.sh 暂未提供）
cp all-in-one.ts ~/.pi/agent/extensions/
cd ~/.pi/agent/extensions
[ -f package.json ] || npm init -y
npm install better-sqlite3@^11.3.0 pdf-parse@^1.1.1
```

> 安装后**必须重启 Pi**（或重启 Tauri 应用）才会重新加载扩展。重启后在 Pi 里问「你能调用哪些工具」，应能看到 `logistic_invoice_packing` / `logistic_customs_generator` / `logistic_customs_extractor` / `logistic_data_analysis` / `logistic_list_tools` 等。
>
> HT 物流工具依赖 Python sidecar（端口 8000），需先启动 Tauri 应用（它会自动拉起 sidecar）。
