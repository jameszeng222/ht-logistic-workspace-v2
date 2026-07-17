// ~/.pi/agent/extensions/all-in-one.ts
// 全场景助理 Extension：覆盖 数据分析 / 文档处理 / 自动化 / 任务管理 / HT 物流 五域
// HT 物流域的 5 个工具通过 HTTP 调用 Python sidecar（python-sidecar/，FastAPI on 127.0.0.1:8000）。
//
// 依赖安装（在 ~/.pi/agent/extensions/ 目录下）：
//   cd ~/.pi/agent/extensions
//   npm init -y
//   npm install better-sqlite3 pdf-parse
//
// Pi 用 jiti 加载 TS，无需编译；npm 依赖放同目录即可

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

// ============ 安全配置（按需修改）============
// query_database 仅允许读这些库
const ALLOWED_DB_FILES = ["~/.pi/data.db"];
// http_request 仅允许这些域名
const HTTP_DOMAIN_WHITELIST = ["api.github.com", "api.weatherapi.com"];
// run_script 仅允许这些脚本
const SCRIPT_WHITELIST = ["~/.pi/scripts/sync.sh"];

const DB_PATH = "~/.pi/data.db"; // 任务/笔记库

function expandHome(p: string): string {
  return p.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "");
}

// HT 物流工具 sidecar 地址（FastAPI on 127.0.0.1:8000，由 Tauri 主进程拉起）
// 扩展调用工具时通过此 HTTP 接口与 Python 工具层交互，避免在 Node 端复刻 Excel/PDF 处理逻辑。
const SIDECAR_URL = process.env.HT_SIDECAR_URL || "http://127.0.0.1:8000";

/**
 * 调用 sidecar 工具接口的通用封装：读本地文件 → multipart 上传 → 保存返回的二进制结果到磁盘。
 * 返回保存路径供 LLM 告知用户。
 */
async function callSidecarTool(
  endpoint: string,
  filePath: string,
  outExt: "zip" | "xlsx",
  toolName: string
): Promise<{ content: any[]; details: any }> {
  const fs = require("node:fs");
  const path = require("node:path");
  if (!fs.existsSync(filePath)) {
    throw new Error(`输入文件不存在：${filePath}`);
  }
  const fileBytes = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const form = new FormData();
  form.append("file", new Blob([fileBytes]), fileName);

  let resp: Response;
  try {
    resp = await fetch(`${SIDECAR_URL}${endpoint}`, { method: "POST", body: form });
  } catch (e: any) {
    throw new Error(`无法连接 sidecar（${SIDECAR_URL}）：${e.message}。请确认 Tauri 已启动 Python sidecar。`);
  }
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).detail || ""; } catch {}
    throw new Error(`工具执行失败 HTTP ${resp.status}：${detail || resp.statusText}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  // 输出到 ~/.pi/outputs/<toolName>-<timestamp>.<ext>
  const outDir = expandHome("~/.pi/outputs");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = path.join(outDir, `${toolName}-${ts}.${outExt}`);
  fs.writeFileSync(outPath, buf);
  const sizeKb = (buf.length / 1024).toFixed(1);
  return {
    content: [
      {
        type: "text",
        text: `已生成结果文件：${outPath}（${sizeKb} KB）。请告知用户该路径，用户可在文件管理器中打开。`,
      },
    ],
    details: { outPath, sizeBytes: buf.length },
  };
}

/**
 * 调用返回 JSON 的 sidecar 工具：读本地文件 → multipart 上传 → 直接把 JSON 结果回给 LLM。
 * 与 callSidecarTool 的区别：sidecar 返回 JSON（非二进制），不落盘，让 AI 直接解读结构化结果。
 * 用于 data-analysis 这类「输出供 AI 解读而非供用户下载」的工具。
 */
async function callSidecarJsonTool(
  endpoint: string,
  filePath: string
): Promise<{ content: any[]; details: any }> {
  const fs = require("node:fs");
  const path = require("node:path");
  if (!fs.existsSync(filePath)) {
    throw new Error(`输入文件不存在：${filePath}`);
  }
  const fileBytes = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const form = new FormData();
  form.append("file", new Blob([fileBytes]), fileName);

  let resp: Response;
  try {
    resp = await fetch(`${SIDECAR_URL}${endpoint}`, { method: "POST", body: form });
  } catch (e: any) {
    throw new Error(`无法连接 sidecar（${SIDECAR_URL}）：${e.message}。请确认 Tauri 已启动 Python sidecar。`);
  }
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).detail || ""; } catch {}
    throw new Error(`工具执行失败 HTTP ${resp.status}：${detail || resp.statusText}`);
  }
  const data = await resp.json();
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: { raw: data },
  };
}

export default function (pi: ExtensionAPI) {
  // 读 models.json，用 pi.registerProvider() 注册所有已配置的 provider。
  // Pi 官方支持自动读 models.json，但在 RPC 模式下可能不自动重载。
  // 扩展在 Pi 启动时加载（工厂函数在 startup 前执行），这里主动注册更可靠。
  // 文档：pi.dev/docs/latest/custom-provider（pi.registerProvider）
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const modelsJsonPath = path.join(
      expandHome("~"), ".pi", "agent", "models.json"
    );
    if (fs.existsSync(modelsJsonPath)) {
      const config = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
      if (config.providers) {
        for (const [id, provider] of Object.entries(config.providers)) {
          const p = provider as any;
          if (!p.apiKey || !p.models || p.models.length === 0) continue;
          // 解析 apiKey：$ENV_VAR 格式从环境变量读值，明文直接用
          let apiKey = p.apiKey;
          if (typeof apiKey === "string" && apiKey.startsWith("$")) {
            const varName = apiKey.replace(/^\$\{?/, "").replace(/\}$/, "");
            apiKey = process.env[varName] || "";
            if (!apiKey) continue;
          }
          pi.registerProvider(id, {
            baseUrl: p.baseUrl,
            api: p.api || "openai-completions",
            apiKey: apiKey,
            models: p.models.map((m: any) => ({
              id: m.id,
              name: m.name || m.id,
              reasoning: m.reasoning || false,
              input: m.input || ["text"],
              cost: {
                input: Number(m.cost?.input) || 0,
                output: Number(m.cost?.output) || 0,
                cacheRead: Number(m.cost?.cacheRead) || 0,
                cacheWrite: Number(m.cost?.cacheWrite) || 0,
                tiers: Array.isArray(m.cost?.tiers) ? m.cost.tiers : [],
              },
              contextWindow: m.contextWindow || 128000,
              maxTokens: m.maxTokens || 4096,
            })),
          });
        }
      }
    }
  } catch (e) {
    // models.json 不存在或解析失败，静默跳过（Pi 可能自己读了）
  }

  // Feature detection: optional deps. If missing, skip registering dependent
  // tools so the extension still loads (core logistic tools unaffected).
  // better-sqlite3 is a native module needing Python + VS Build Tools to compile
  // on Windows when no prebuilt binary exists (e.g. Node 24); if the user lacks
  // build tools, degrade gracefully instead of failing the whole extension.
  const HAVE_BSQL = (() => { try { require("better-sqlite3"); return true; } catch { return false; } })();
  const HAVE_PDFPARSE = (() => { try { require("pdf-parse"); return true; } catch { return false; } })();

  // 启动时禁用危险默认工具（bash/edit/write 等），保留 read + 所有扩展注册的工具。
  // 注意：pi.setActiveTools 对内置工具与动态注册工具都生效（见 pi.dev extensions 文档），
  //       因此不能写成 setActiveTools(["read"])——那会把本扩展注册的 16 个工具也禁用掉。
  pi.on("session_start", async (_event, ctx) => {
    let keep: string[] = ["read"];
    try {
      const all = pi.getAllTools();
      // 保留 read + 所有非内置工具（即扩展注册的工具），剔除其它内置工具（bash/edit/write/apply_patch 等）
      keep = all
        .filter((t: any) => t?.sourceInfo?.source !== "builtin" || t?.name === "read")
        .map((t: any) => t.name);
      if (keep.length === 0) keep = ["read"];
    } catch {
      keep = ["read"];
    }
    pi.setActiveTools(keep);
    const domains = ["HT 物流", "自动化"];
    if (HAVE_BSQL) domains.push("数据分析/任务笔记");
    if (HAVE_PDFPARSE) domains.push("文档处理");
    ctx.ui.notify(`全场景助理已加载（${domains.join("、")}）`, "info");
    if (!HAVE_BSQL) {
      ctx.ui.notify("better-sqlite3 未安装，已跳过 SQLite 工具（任务/笔记/数据库查询）", "warn");
    }
  });

  // ==================== 数据分析域 ====================
  if (HAVE_BSQL) {
  pi.registerTool({
    name: "query_database",
    description: "查询本地 SQLite 数据库（只读）。当用户要分析数据、查表、出报表时使用。",
    promptGuidelines: ["仅允许 SELECT；禁止 INSERT/UPDATE/DELETE/DROP"],
    parameters: Type.Object({
      dbPath: Type.String({ description: "数据库文件路径" }),
      sql: Type.String({ description: "SQL 查询语句，必须是 SELECT" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const expanded = expandHome(params.dbPath);
      if (!ALLOWED_DB_FILES.includes(params.dbPath)) {
        throw new Error(`数据库不在白名单：${params.dbPath}`);
      }
      if (!/^\s*select\b/i.test(params.sql)) {
        throw new Error("仅允许 SELECT 查询");
      }
      const Database = require("better-sqlite3");
      const db = new Database(expanded, { readonly: true, timeout: 30000 });
      try {
        const rows = db.prepare(params.sql).all();
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          details: { rowCount: rows.length },
        };
      } finally {
        db.close();
      }
    },
  });
  } // HAVE_BSQL (query_database)

  pi.registerTool({
    name: "chart_render",
    description: "生成图表配置（Chart.js 格式）。当需要可视化数据时使用。",
    parameters: Type.Object({
      type: StringEnum(["bar", "line", "pie", "doughnut"] as const),
      title: Type.String(),
      labels: Type.Array(Type.String()),
      datasets: Type.Array(
        Type.Object({ label: Type.String(), data: Type.Array(Type.Number()) })
      ),
    }),
    async execute(_id, params) {
      return {
        content: [{ type: "text", text: `图表已生成：${params.title}` }],
        details: {
          chartConfig: {
            type: params.type,
            data: { labels: params.labels, datasets: params.datasets },
            options: { plugins: { title: { display: true, text: params.title } } },
          },
        },
      };
    },
  });

  // ==================== 文档处理域 ====================
  if (HAVE_PDFPARSE) {
  pi.registerTool({
    name: "parse_pdf",
    description: "解析 PDF 提取文本。当用户上传 PDF 要总结/问答时使用。",
    parameters: Type.Object({
      path: Type.String({ description: "PDF 文件绝对路径" }),
    }),
    async execute(_id, params) {
      const fs = require("node:fs");
      if (!fs.existsSync(params.path)) {
        throw new Error(`文件不存在：${params.path}`);
      }
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(fs.readFileSync(params.path));
      return {
        content: [{ type: "text", text: data.text.slice(0, 8000) }],
        // 不回传完整路径给 LLM（SYSTEM.md 安全边界：不向用户暴露完整文件路径）
        details: { pages: data.numpages },
      };
    },
  });
  } // HAVE_PDFPARSE (parse_pdf)

  pi.registerTool({
    // 注意：本工具实现为子串匹配（lowercased indexOf），并非真正的向量语义检索。
    // 故命名为 kb_search（知识库检索）以避免误导。如需语义检索可后续接入嵌入向量。
    name: "kb_search",
    description: "在本地知识库中检索相关片段（大小写不敏感的子串匹配，非向量语义检索）。当问知识库相关问题时使用。",
    parameters: Type.Object({
      query: Type.String(),
      kbDir: Type.Optional(Type.String({ description: "知识库目录，默认 ~/.pi/kb" })),
    }),
    async execute(_id, params) {
      const fs = require("node:fs");
      const path = require("node:path");
      const kbDir = expandHome(params.kbDir || "~/.pi/kb");
      if (!fs.existsSync(kbDir)) {
        throw new Error(`知识库目录不存在：${kbDir}`);
      }
      const q = params.query.toLowerCase();
      const results: any[] = [];
      for (const file of fs.readdirSync(kbDir)) {
        if (!file.endsWith(".md") && !file.endsWith(".txt")) continue;
        const content = fs.readFileSync(path.join(kbDir, file), "utf8");
        const lower = content.toLowerCase();
        let idx = lower.indexOf(q);
        while (idx >= 0 && results.length < 10) {
          const start = Math.max(0, idx - 100);
          results.push({
            file,
            snippet: content.slice(start, idx + q.length + 200),
          });
          idx = lower.indexOf(q, idx + 1);
        }
      }
      return {
        content: [
          {
            type: "text",
            text: results.length
              ? JSON.stringify(results, null, 2)
              : "未找到匹配",
          },
        ],
        details: { matchCount: results.length },
      };
    },
  });

  // ==================== 自动化域 ====================
  pi.registerTool({
    name: "http_request",
    description: "发起 HTTP 请求（仅限白名单域名）。当需要调外部 API 时使用。",
    parameters: Type.Object({
      url: Type.String(),
      method: StringEnum(["GET", "POST", "PUT", "DELETE"] as const),
      body: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const u = new URL(params.url);
      if (!HTTP_DOMAIN_WHITELIST.includes(u.hostname)) {
        throw new Error(
          `域名不在白名单：${u.hostname}（白名单：${HTTP_DOMAIN_WHITELIST.join(", ")}）`
        );
      }
      if (params.method !== "GET") {
        const ok = await ctx.ui.confirm(
          `${params.method} ${params.url}`,
          "将发起写操作，确认？"
        );
        if (!ok) throw new Error("用户取消");
      }
      const res = await fetch(params.url, {
        method: params.method,
        body: params.body,
      });
      const text = await res.text();
      return {
        content: [{ type: "text", text: `HTTP ${res.status}\n${text.slice(0, 4000)}` }],
        details: { status: res.status, fullText: text },
      };
    },
  });

  pi.registerTool({
    name: "run_script",
    description: "执行白名单脚本。当需要跑本地脚本时使用。",
    parameters: Type.Object({
      script: Type.String({ description: "脚本路径（必须在白名单）" }),
      args: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!SCRIPT_WHITELIST.includes(params.script)) {
        throw new Error(`脚本不在白名单：${params.script}`);
      }
      const expanded = expandHome(params.script);
      const ok = await ctx.ui.confirm(
        "执行脚本",
        `${expanded} ${params.args?.join(" ") || ""}`
      );
      if (!ok) throw new Error("用户取消");
      const { execFile } = require("node:child_process");
      return new Promise((resolve) => {
        execFile(
          expanded,
          params.args || [],
          { timeout: 30000 },
          (err: any, stdout: string, stderr: string) => {
            resolve({
              content: [
                {
                  type: "text",
                  text: `exit ${err ? err.code || 1 : 0}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
                },
              ],
              details: { error: err?.message },
            });
          }
        );
      });
    },
  });

  // ==================== 任务/笔记管理域 ====================
  if (HAVE_BSQL) {
  function openDb() {
    const Database = require("better-sqlite3");
    const fs = require("node:fs");
    const path = require("node:path");
    const dbPath = expandHome(DB_PATH);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, title TEXT, status TEXT, priority INTEGER, due TEXT
      );
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY, title TEXT UNIQUE, body TEXT, tags TEXT, updated TEXT
      );
    `);
    return db;
  }

  pi.registerTool({
    name: "task_create",
    description: "创建任务。当用户要新增待办时使用。",
    parameters: Type.Object({
      title: Type.String(),
      priority: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
      due: Type.Optional(Type.String({ description: "ISO 8601 日期" })),
    }),
    async execute(_id, params) {
      const db = openDb();
      try {
        const r = db
          .prepare(
            "INSERT INTO tasks (title, status, priority, due) VALUES (?, 'todo', ?, ?)"
          )
          .run(params.title, params.priority || 3, params.due || null);
        return {
          content: [{ type: "text", text: `已创建任务 #${r.lastInsertRowid}：${params.title}` }],
          details: { id: r.lastInsertRowid },
        };
      } finally {
        db.close();
      }
    },
  });

  pi.registerTool({
    name: "task_list",
    description: "列出任务。当用户要看待办列表时使用。",
    parameters: Type.Object({
      status: Type.Optional(StringEnum(["todo", "doing", "done", "all"] as const)),
    }),
    async execute(_id, params) {
      const db = openDb();
      try {
        const where = params.status && params.status !== "all" ? "WHERE status = ?" : "";
        const args = params.status && params.status !== "all" ? [params.status] : [];
        const rows = db
          .prepare(`SELECT * FROM tasks ${where} ORDER BY priority, due`)
          .all(...args);
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          details: { count: rows.length },
        };
      } finally {
        db.close();
      }
    },
  });

  pi.registerTool({
    name: "task_update",
    description: "更新任务状态/优先级。删除任务用 status='deleted'。",
    parameters: Type.Object({
      id: Type.Integer(),
      status: Type.Optional(StringEnum(["todo", "doing", "done", "deleted"] as const)),
      priority: Type.Optional(Type.Integer()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = openDb();
      try {
        const cur: any = db.prepare("SELECT * FROM tasks WHERE id = ?").get(params.id);
        if (!cur) throw new Error(`任务不存在：${params.id}`);
        if (params.status === "deleted") {
          const ok = await ctx.ui.confirm("删除任务", `确认删除 #${params.id}：${cur.title}`);
          if (!ok) throw new Error("用户取消");
        }
        db.prepare(
          "UPDATE tasks SET status = COALESCE(?, status), priority = COALESCE(?, priority) WHERE id = ?"
        ).run(params.status || null, params.priority || null, params.id);
        return { content: [{ type: "text", text: `已更新任务 #${params.id}` }], details: {} };
      } finally {
        db.close();
      }
    },
  });

  pi.registerTool({
    name: "note_upsert",
    description: "新增/更新笔记（按 title 匹配，存在则覆盖）。",
    parameters: Type.Object({
      title: Type.String(),
      body: Type.String(),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params) {
      const db = openDb();
      try {
        db.prepare(
          `INSERT INTO notes (title, body, tags, updated) VALUES (?, ?, ?, ?)
           ON CONFLICT(title) DO UPDATE SET body=excluded.body, tags=excluded.tags, updated=excluded.updated`
        ).run(params.title, params.body, (params.tags || []).join(","), new Date().toISOString());
        return { content: [{ type: "text", text: `已保存笔记：${params.title}` }], details: {} };
      } finally {
        db.close();
      }
    },
  });

  pi.registerTool({
    name: "note_search",
    description: "搜索笔记（标题或正文匹配）。",
    parameters: Type.Object({ keyword: Type.String() }),
    async execute(_id, params) {
      const db = openDb();
      try {
        const rows = db
          .prepare(
            "SELECT id, title, tags, updated FROM notes WHERE title LIKE ? OR body LIKE ? ORDER BY updated DESC"
          )
          .all(`%${params.keyword}%`, `%${params.keyword}%`);
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
          details: { count: rows.length },
        };
      } finally {
        db.close();
      }
    },
  });
  } // HAVE_BSQL (task/note tools)

  // ==================== HT 物流工具域 ====================
  // 这三个工具通过 HTTP 调用 Python sidecar（FastAPI on 127.0.0.1:8000），
  // 让 AI 助手能直接处理发票/箱单/报关单，而无需把 Excel/PDF 处理逻辑搬进 Node。
  // 工具流：用户给文件路径 → 扩展读文件 → POST sidecar → 保存结果到 ~/.pi/outputs/ → 返回路径给 LLM。
  // 与前端「工具」tab 的区别：tab 是人工操作；这里是 AI 自主调用。
  pi.registerTool({
    name: "logistic_invoice_packing",
    description: "生成发票和箱单。上传数据源 Excel（含万邑通单号），按德速/联宇模板批量生成发票+箱单，输出 zip。当用户要做出库发票箱单时使用。",
    parameters: Type.Object({
      filePath: Type.String({ description: "数据源 Excel 文件绝对路径（.xlsx）" }),
    }),
    async execute(_id, params) {
      return callSidecarTool("/api/tools/invoice-packing", params.filePath, "zip", "invoice-packing");
    },
  });

  pi.registerTool({
    name: "logistic_customs_generator",
    description: "生成报关箱单。上传数据源 Excel，按 FBA/WI/合并报关三种情况生成报关箱单文件，输出 zip。当用户要做报关单据时使用。",
    parameters: Type.Object({
      filePath: Type.String({ description: "数据源 Excel 文件绝对路径（.xlsx）" }),
    }),
    async execute(_id, params) {
      return callSidecarTool("/api/tools/customs-generator", params.filePath, "zip", "customs-generator");
    },
  });

  pi.registerTool({
    name: "logistic_customs_extractor",
    description: "提取报关单信息。上传报关单 PDF，通过 OCR + 正则提取关键字段（发货人/申报号/HS编码/品名/数量/金额等），输出 Excel。当用户要从 PDF 报关单抽取结构化数据时使用。",
    parameters: Type.Object({
      filePath: Type.String({ description: "报关单 PDF 文件绝对路径" }),
    }),
    async execute(_id, params) {
      return callSidecarTool("/api/tools/customs-extractor", params.filePath, "xlsx", "customs-extracted");
    },
  });

  pi.registerTool({
    name: "logistic_data_analysis",
    description: "Excel 数据分析。上传 Excel/CSV，自动按列类型统计（数值列：均值/标准差/分位数/直方图；分类列：唯一值/Top 频次/占比；时间列：范围/跨度）并计算数值列间相关性，返回 JSON 报告。当用户要分析 Excel 数据分布、找异常、看趋势时使用，结果直接供 AI 解读。",
    parameters: Type.Object({
      filePath: Type.String({ description: "Excel/CSV 文件绝对路径（.xlsx/.xls/.csv）" }),
    }),
    async execute(_id, params) {
      return callSidecarJsonTool("/api/tools/data-analysis", params.filePath);
    },
  });

  pi.registerTool({
    name: "logistic_list_tools",
    description: "列出 sidecar 当前可用的物流工具及其输入输出类型。当不确定有哪些工具时可先调用此查询。",
    parameters: Type.Object({}),
    async execute() {
      let resp: Response;
      try {
        resp = await fetch(`${SIDECAR_URL}/api/tools`);
      } catch (e: any) {
        throw new Error(`无法连接 sidecar：${e.message}`);
      }
      const data = await resp.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data.tools || [], null, 2) }],
        details: { count: data.tools?.length || 0 },
      };
    },
  });

  // HS 编码查询：直接读本地 JSON 数据文件，不依赖 sidecar HTTP 调用。
  // Pi 扩展环境的 fetch 调 localhost 可能受限，改为直接读文件避免网络依赖。
  // 数据文件路径：~/.pi/agent/hs_codes.json（由 Rust 端首次启动时生成）
  // 如果数据文件不存在，用内嵌的示例数据。
  const HS_CODES_BUILTIN = [
    { code: "6109100021", name: "棉制针织或钩编的T恤衫、汗衫及其他背心", category: "第十一类 纺织原料及纺织制品", tax_rate: "6%", unit: "件", export_rebate: "13%" },
    { code: "6109100091", name: "其他棉制针织或钩编的T恤衫、汗衫", category: "第十一类 纺织原料及纺织制品", tax_rate: "6%", unit: "件", export_rebate: "13%" },
    { code: "62034290", name: "棉制男式长裤、工装裤等", category: "第十一类 纺织原料及纺织制品", tax_rate: "6%", unit: "条", export_rebate: "13%" },
    { code: "64029929", name: "橡塑底及面其他鞋靴", category: "第十二类 鞋、帽、伞、杖、鞭", tax_rate: "10%", unit: "双", export_rebate: "13%" },
    { code: "95030021", name: "羽毛制羽毛球", category: "第二十类 杂项制品", tax_rate: "6%", unit: "个", export_rebate: "13%" },
    { code: "85234910", name: "其他光盘（非仅录制声音）", category: "第十六类 机器、机械器具", tax_rate: "0%", unit: "张", export_rebate: "13%" },
    { code: "85171200", name: "电话机（智能手机等）", category: "第十六类 机器、机械器具", tax_rate: "0%", unit: "台", export_rebate: "13%" },
    { code: "49019900", name: "其他书籍、小册子及类似印刷品", category: "第十类 木浆及纸", tax_rate: "0%", unit: "千克", export_rebate: "10%" },
    { code: "33030000", name: "香水及花露水", category: "第六类 化工产品", tax_rate: "3%", unit: "千克", export_rebate: "13%" },
    { code: "42022100", name: "皮革、再生皮革制手提包", category: "第八类 皮革制品", tax_rate: "6%", unit: "个", export_rebate: "13%" },
    { code: "71131919", name: "其他贵金属制首饰", category: "第十五类 贱金属及其制品", tax_rate: "10%", unit: "克", export_rebate: "13%" },
    { code: "94035010", name: "卧室用木家具", category: "第二十类 杂项制品", tax_rate: "0%", unit: "件", export_rebate: "13%" },
    { code: "39241000", name: "塑料制餐具及厨房用具", category: "第七类 塑料及其制品", tax_rate: "6%", unit: "千克", export_rebate: "13%" },
    { code: "69120010", name: "陶瓷餐具", category: "第十三类 陶瓷产品", tax_rate: "6%", unit: "个", export_rebate: "13%" },
    { code: "21011100", name: "咖啡浓缩精汁及以其为基本成分的制品", category: "第一类 活动物；动物产品", tax_rate: "10%", unit: "千克", export_rebate: "13%" },
    { code: "18063200", name: "巧克力（夹心或非夹心）", category: "第二类 植物产品", tax_rate: "8%", unit: "千克", export_rebate: "13%" },
    { code: "22042100", name: "2升及以下容器装鲜葡萄酿酒", category: "第四类 饮料、酒及醋", tax_rate: "14%", unit: "升", export_rebate: "13%" },
    { code: "30049059", name: "其他混合或非混合产品（中药酒等）", category: "第六类 化工产品", tax_rate: "3%", unit: "千克", export_rebate: "13%" },
    { code: "84713000", name: "便携式数字自动数据处理设备（笔记本电脑等）", category: "第十六类 机器、机械器具", tax_rate: "0%", unit: "台", export_rebate: "13%" },
    { code: "85287212", name: "彩色液晶电视机（屏幕＞52cm）", category: "第十六类 机器、机械器具", tax_rate: "15%", unit: "台", export_rebate: "13%" },
    { code: "84151010", name: "独立式空调器（制冷≤14000大卡/时）", category: "第十六类 机器、机械器具", tax_rate: "0%", unit: "台", export_rebate: "13%" },
    { code: "85044013", name: "手机用充电器（开关电源）", category: "第十六类 机器、机械器具", tax_rate: "0%", unit: "个", export_rebate: "13%" },
    { code: "85076000", name: "锂离子蓄电池", category: "第十六类 机器、机械器具", tax_rate: "6%", unit: "个", export_rebate: "13%" },
    { code: "87089999", name: "机动车辆用其他零件、附件", category: "第十七类 车辆、航空器", tax_rate: "6%", unit: "千克", export_rebate: "13%" },
    { code: "87120030", name: "电动自行车", category: "第十七类 车辆、航空器", tax_rate: "5%", unit: "辆", export_rebate: "13%" },
    { code: "95063200", name: "高尔夫球棍", category: "第二十类 杂项制品", tax_rate: "6%", unit: "根", export_rebate: "13%" },
    { code: "95066210", name: "篮球、排球、足球", category: "第二十类 杂项制品", tax_rate: "6%", unit: "个", export_rebate: "13%" },
    { code: "61099090", name: "其他纺织材料制针织或钩编T恤衫", category: "第十一类 纺织原料及纺织制品", tax_rate: "6%", unit: "件", export_rebate: "13%" },
    { code: "61102000", name: "棉制针织或钩编的套头衫、开襟衫、马甲", category: "第十一类 纺织原料及纺织制品", tax_rate: "6%", unit: "件", export_rebate: "13%" },
    { code: "62014090", name: "其他纺织材料制女式大衣、斗篷", category: "第十一类 纺织原料及纺织制品", tax_rate: "6%", unit: "件", export_rebate: "13%" },
  ];

  pi.registerTool({
    name: "logistic_hs_code",
    description: "查询 HS 编码。输入 HS 编码（纯数字，如 6109100021）或品名关键词（如 棉制T恤），返回匹配的编码/品名/税率/计量单位/出口退税率。当用户要查 HS 编码、确认商品归类、看税率退税率时使用。",
    parameters: Type.Object({
      query: Type.String({ description: "HS 编码（纯数字）或品名关键词（中文）" }),
    }),
    async execute(_id, params) {
      // 直接读本地 JSON 数据文件，不依赖 sidecar HTTP 调用
      const fs = require("node:fs");
      const path = require("node:path");
      let data = HS_CODES_BUILTIN;
      const dbPath = path.join(expandHome("~"), ".pi", "agent", "hs_codes.json");
      try {
        if (fs.existsSync(dbPath)) {
          data = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
        }
      } catch { /* 用内嵌数据 */ }

      const query = (params.query || "").trim();
      if (!query) {
        return { content: [{ type: "text", text: "查询为空" }], details: { count: 0 } };
      }

      const isCodeQuery = /^\d+$/.test(query.replace(/\s/g, ""));
      let results: any[];
      if (isCodeQuery) {
        const code = query.replace(/\s/g, "");
        results = data.filter((d: any) => d.code === code || d.code.startsWith(code));
      } else {
        const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
        results = data.filter((d: any) =>
          keywords.every((kw: string) => (d.name || "").toLowerCase().includes(kw))
        );
      }
      results = results.slice(0, 20);

      const result = {
        query,
        match_type: results.length > 0 ? (isCodeQuery ? "code" : "name") : "none",
        results,
        count: results.length,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { count: results.length, matchType: result.match_type },
      };
    },
  });
}
