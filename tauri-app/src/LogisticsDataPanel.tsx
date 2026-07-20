import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  CloudDownload,
  Database,
  ExternalLink,
  KeyRound,
  Link2,
  LoaderCircle,
  RefreshCw,
  Save,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Table2,
  Trash2,
} from "lucide-react";

interface FeishuConnection {
  configured: boolean;
  appId: string | null;
}

interface FeishuSheet {
  sheet_id?: string;
  sheetId?: string;
  title?: string;
  index?: number;
  grid_properties?: { row_count?: number; column_count?: number };
}

interface SourceConfig {
  name: string;
  url: string;
  sheetId: string;
  range: string;
}

interface FieldMapping {
  customer: string;
  status: string;
  amount: string;
  date: string;
  tracking: string;
  route: string;
}

interface DataMetric {
  key: string;
  label: string;
  value: string;
  detail: string;
}

interface DataColumn {
  name: string;
  kind: string;
  missing: number;
  missingPct: number;
  unique: number;
  sample: string[];
}

interface DataAnomaly {
  severity: "warning" | "danger" | "info";
  title: string;
  detail: string;
  count: number;
  field?: string | null;
}

interface DataDistribution {
  field: string;
  items: Array<{ label: string; count: number; percent: number }>;
}

interface LogisticsReport {
  sourceName: string;
  rows: number;
  columnCount: number;
  completeness: number;
  metrics: DataMetric[];
  columns: DataColumn[];
  anomalies: DataAnomaly[];
  distributions: DataDistribution[];
  sampleRows: Array<Record<string, unknown>>;
  summary: string;
}

interface LogisticsDataPanelProps {
  onSendToAssistant: (message: string) => void;
}

const SOURCE_KEY = "ht-feishu-logistics-source";
const EMPTY_MAPPING: FieldMapping = { customer: "", status: "", amount: "", date: "", tracking: "", route: "" };

const MAPPING_FIELDS: Array<{ key: keyof FieldMapping; label: string; hint: string }> = [
  { key: "tracking", label: "业务单号", hint: "用于重复检查" },
  { key: "customer", label: "客户", hint: "用于客户分布" },
  { key: "status", label: "状态", hint: "用于进度统计" },
  { key: "amount", label: "金额", hint: "用于合计与异常" },
  { key: "date", label: "业务日期", hint: "用于时间范围" },
  { key: "route", label: "线路/渠道", hint: "用于业务分布" },
];

const DEMO_VALUES: unknown[][] = [
  ["运单号", "客户名称", "运输状态", "应收金额", "发货日期", "运输线路"],
  ["HT260701", "德远贸易", "已完成", 12800, "2026-07-01", "德国专线"],
  ["HT260702", "德远贸易", "运输中", 9600, "2026-07-02", "德国专线"],
  ["HT260703", "联宇科技", "待提货", 7200, "2026-07-03", "英国专线"],
  ["HT260704", "万邑通", "已完成", 15600, "2026-07-04", "德国专线"],
  ["HT260705", "联宇科技", "异常待处理", -300, "日期待确认", "美国海运"],
  ["HT260705", "", "运输中", 11200, "2026-07-06", "美国海运"],
  ["HT260707", "盛达供应链", "已完成", 18900, "2026-07-07", "英国专线"],
  ["HT260708", "万邑通", "待提货", 8400, "2026-07-08", "德国专线"],
];

function loadSource(): SourceConfig {
  try {
    const stored = JSON.parse(localStorage.getItem(SOURCE_KEY) || "null");
    if (stored && typeof stored.name === "string" && typeof stored.url === "string") {
      return {
        name: stored.name,
        url: stored.url,
        sheetId: typeof stored.sheetId === "string" ? stored.sheetId : "",
        range: typeof stored.range === "string" ? stored.range : "A1:Z2000",
      };
    }
  } catch { /* ignore invalid local preferences */ }
  return { name: "业务数据表", url: "", sheetId: "", range: "A1:Z2000" };
}

function sheetId(sheet: FeishuSheet): string {
  return sheet.sheet_id || sheet.sheetId || "";
}

function autoMapping(columns: string[]): FieldMapping {
  const find = (...patterns: RegExp[]) => columns.find((column) => patterns.some((pattern) => pattern.test(column))) || "";
  return {
    tracking: find(/单号|运单|提单|tracking|order/i),
    customer: find(/客户|委托方|customer|client/i),
    status: find(/状态|进度|status/i),
    amount: find(/金额|费用|收入|应收|运费|amount|revenue/i),
    date: find(/日期|时间|发货日|创建日|date|time/i),
    route: find(/线路|渠道|航线|供应商|route|channel/i),
  };
}

function kindLabel(kind: string): string {
  if (kind === "numeric") return "数值";
  if (kind === "datetime") return "日期";
  if (kind === "categorical") return "分类";
  if (kind === "empty") return "空列";
  return "文本";
}

export function LogisticsDataPanel({ onSendToAssistant }: LogisticsDataPanelProps) {
  const [connection, setConnection] = useState<FeishuConnection>({ configured: false, appId: null });
  const [showCredentials, setShowCredentials] = useState(false);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [source, setSource] = useState<SourceConfig>(loadSource);
  const [sheets, setSheets] = useState<FeishuSheet[]>([]);
  const [mapping, setMapping] = useState<FieldMapping>(EMPTY_MAPPING);
  const [rawValues, setRawValues] = useState<unknown[][] | null>(null);
  const [report, setReport] = useState<LogisticsReport | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [loading, setLoading] = useState<"credentials" | "sheets" | "sync" | "analyze" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<FeishuConnection>("get_feishu_connection")
      .then((value) => {
        setConnection(value);
        if (value.appId) setAppId(value.appId);
        setShowCredentials(!value.configured);
      })
      .catch(() => setShowCredentials(true));
  }, []);

  useEffect(() => {
    localStorage.setItem(SOURCE_KEY, JSON.stringify(source));
  }, [source]);

  const columns = report?.columns.map((column) => column.name) || [];
  const mappedCount = useMemo(() => Object.values(mapping).filter(Boolean).length, [mapping]);

  const sidecarUrl = useCallback(async () => {
    try {
      const status = await invoke<{ url?: string }>("sidecar_status");
      return status.url || "http://127.0.0.1:8000";
    } catch {
      return "http://127.0.0.1:8000";
    }
  }, []);

  const analyze = useCallback(async (values: unknown[][], nextMapping: FieldMapping, sourceName: string) => {
    setLoading("analyze");
    setError(null);
    try {
      const baseUrl = await sidecarUrl();
      const response = await fetch(`${baseUrl}/api/logistics-data/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values, mapping: nextMapping, source_name: sourceName }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || `分析服务返回 ${response.status}`);
      setReport(payload as LogisticsReport);
      setLastSync(Date.now());
    } catch (reason) {
      setError(`分析失败：${String(reason)}`);
    } finally {
      setLoading(null);
    }
  }, [sidecarUrl]);

  const saveCredentials = useCallback(async () => {
    if (!appId.trim() || !appSecret.trim()) {
      setError("请填写 App ID 和 App Secret");
      return;
    }
    setLoading("credentials");
    setError(null);
    try {
      const value = await invoke<FeishuConnection>("save_feishu_credentials", { appId, appSecret });
      setConnection(value);
      setAppSecret("");
      setShowCredentials(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(null);
    }
  }, [appId, appSecret]);

  const clearCredentials = useCallback(async () => {
    try { await invoke("clear_feishu_credentials"); } catch { /* best effort */ }
    setConnection({ configured: false, appId: null });
    setAppSecret("");
    setSheets([]);
    setShowCredentials(true);
  }, []);

  const loadSheets = useCallback(async () => {
    if (!source.url.trim()) {
      setError("请先粘贴飞书表格链接");
      return;
    }
    setLoading("sheets");
    setError(null);
    try {
      const result = await invoke<{ sheets: FeishuSheet[] }>("feishu_list_sheets", { spreadsheetUrl: source.url });
      const nextSheets = Array.isArray(result.sheets) ? result.sheets : [];
      setSheets(nextSheets);
      if (nextSheets.length > 0 && !nextSheets.some((sheet) => sheetId(sheet) === source.sheetId)) {
        setSource((current) => ({ ...current, sheetId: sheetId(nextSheets[0]) }));
      }
      if (nextSheets.length === 0) setError("连接成功，但没有读取到工作表");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(null);
    }
  }, [source.sheetId, source.url]);

  const sync = useCallback(async () => {
    if (!source.url.trim() || !source.sheetId) {
      setError("请先连接表格并选择工作表");
      return;
    }
    setLoading("sync");
    setError(null);
    try {
      const result = await invoke<{ values: unknown[][] }>("feishu_fetch_sheet", {
        spreadsheetUrl: source.url,
        sheetId: source.sheetId,
        range: source.range,
      });
      const values = Array.isArray(result.values) ? result.values : [];
      const headers = Array.isArray(values[0]) ? values[0].map((value) => String(value ?? "")) : [];
      const nextMapping = autoMapping(headers);
      setRawValues(values);
      setMapping(nextMapping);
      await analyze(values, nextMapping, source.name || "飞书表格");
    } catch (reason) {
      setError(String(reason));
      setLoading(null);
    }
  }, [analyze, source]);

  const loadDemo = useCallback(async () => {
    const nextMapping = autoMapping(DEMO_VALUES[0].map(String));
    setRawValues(DEMO_VALUES);
    setMapping(nextMapping);
    await analyze(DEMO_VALUES, nextMapping, "物流业务演示数据");
  }, [analyze]);

  const applyMapping = useCallback(() => {
    if (rawValues) analyze(rawValues, mapping, report?.sourceName || source.name);
  }, [analyze, mapping, rawValues, report?.sourceName, source.name]);

  const sendToAi = useCallback(() => {
    if (!report) return;
    const anomalyText = report.anomalies.slice(0, 8).map((item) => `- ${item.title}：${item.detail}`).join("\n") || "- 未发现明显异常";
    const distributionText = report.distributions.map((group) => (
      `${group.field}：${group.items.map((item) => `${item.label} ${item.count}条`).join("、")}`
    )).join("\n");
    onSendToAssistant([
      `请分析下面这份物流数据结果，并给出值得关注的业务变化、风险和下一步行动建议。`,
      `数据源：${report.sourceName}`,
      `概况：${report.summary}`,
      `主要分布：\n${distributionText || "暂无已映射的分类字段"}`,
      `异常：\n${anomalyText}`,
    ].join("\n\n"));
  }, [onSendToAssistant, report]);

  return (
    <>
      <aside className="data-source-sidebar" aria-label="物流数据源">
        <header className="data-source-heading">
          <span><Database size={18} /></span>
          <div><strong>物流数据</strong><small>飞书表格 · 只读同步</small></div>
        </header>

        <section className={`data-connection ${connection.configured ? "connected" : ""}`}>
          <div>
            <span className="data-connection-icon">{connection.configured ? <ShieldCheck size={17} /> : <KeyRound size={17} />}</span>
            <span><strong>{connection.configured ? "飞书应用已连接" : "连接飞书应用"}</strong><small>{connection.configured ? connection.appId : "凭据仅保存在本机"}</small></span>
          </div>
          <button type="button" onClick={() => setShowCredentials((value) => !value)} title="连接设置"><Settings2 size={15} /></button>
        </section>

        {showCredentials && (
          <section className="data-credential-form">
            <label><span>App ID</span><input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_xxxxxxxxx" /></label>
            <label><span>App Secret</span><input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder={connection.configured ? "重新输入应用密钥" : "输入应用密钥"} /></label>
            <div>
              {connection.configured && <button className="data-text-button danger" type="button" onClick={clearCredentials}><Trash2 size={14} />清除</button>}
              <button className="data-primary-button compact" type="button" onClick={saveCredentials} disabled={loading === "credentials"}>
                {loading === "credentials" ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存连接
              </button>
            </div>
          </section>
        )}

        <div className="data-sidebar-label">数据源</div>
        <section className="data-source-form">
          <label><span>名称</span><input value={source.name} onChange={(event) => setSource((current) => ({ ...current, name: event.target.value }))} /></label>
          <label><span>飞书表格链接</span><div className="data-input-with-icon"><Link2 size={14} /><input value={source.url} onChange={(event) => setSource((current) => ({ ...current, url: event.target.value, sheetId: "" }))} placeholder="https://xxx.feishu.cn/sheets/..." /></div></label>
          <button className="data-secondary-button" type="button" onClick={loadSheets} disabled={!connection.configured || loading === "sheets"}>
            {loading === "sheets" ? <LoaderCircle className="spin" size={15} /> : <CloudDownload size={15} />}
            检查权限并读取工作表
          </button>
          <label><span>工作表</span><select value={source.sheetId} onChange={(event) => setSource((current) => ({ ...current, sheetId: event.target.value }))} disabled={sheets.length === 0}>
            <option value="">{sheets.length ? "选择工作表" : "连接后显示"}</option>
            {sheets.map((sheet) => <option key={sheetId(sheet)} value={sheetId(sheet)}>{sheet.title || sheetId(sheet)}</option>)}
          </select></label>
          <label><span>读取范围</span><input value={source.range} onChange={(event) => setSource((current) => ({ ...current, range: event.target.value }))} placeholder="A1:Z2000" /></label>
        </section>

        <div className="data-sidebar-spacer" />
        <button className="data-demo-button" type="button" onClick={loadDemo} disabled={Boolean(loading)}>
          <Sparkles size={15} /><span><strong>查看演示数据</strong><small>无需飞书权限</small></span><ArrowRight size={14} />
        </button>
      </aside>

      <section className="logistics-data-page">
        <header className="data-page-header">
          <div>
            <span className="data-eyebrow">LOGISTICS INTELLIGENCE</span>
            <h1>{report?.sourceName || "物流数据分析"}</h1>
            <p>{report ? report.summary : "从飞书表格同步业务数据，自动整理指标、分布与异常。"}</p>
          </div>
          <div className="data-header-actions">
            {lastSync && <span className="data-last-sync"><CheckCircle2 size={14} />{new Date(lastSync).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 已更新</span>}
            <button className="data-primary-button" type="button" onClick={sync} disabled={!connection.configured || !source.sheetId || Boolean(loading)}>
              {loading === "sync" || loading === "analyze" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}立即同步
            </button>
          </div>
        </header>

        {error && <div className="data-error"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)}>×</button></div>}

        {!report ? (
          <div className="data-empty-state">
            <span className="data-empty-icon"><BarChart3 size={28} /></span>
            <h2>连接一张飞书表格开始分析</h2>
            <p>只读取你授权的范围。原始数据留在本机，AI 仅接收整理后的分析结果。</p>
            <div className="data-empty-capabilities">
              <span><Table2 size={16} /><strong>自动整理</strong><small>识别字段与数据质量</small></span>
              <span><BarChart3 size={16} /><strong>业务分布</strong><small>客户、状态与线路</small></span>
              <span><AlertTriangle size={16} /><strong>异常复核</strong><small>缺失、重复和错误值</small></span>
            </div>
            <button className="data-secondary-button" type="button" onClick={loadDemo}><Sparkles size={15} />先用演示数据看看</button>
          </div>
        ) : (
          <div className="data-report-scroll">
            <section className="data-metrics" aria-label="核心指标">
              {report.metrics.map((metric) => (
                <article key={metric.key}><small>{metric.label}</small><strong>{metric.value}</strong><span>{metric.detail}</span></article>
              ))}
            </section>

            <section className="data-mapping-section">
              <header><div><strong>字段映射</strong><small>告诉系统每一列在物流业务中的含义</small></div><span>{mappedCount}/6 已识别</span></header>
              <div className="data-mapping-grid">
                {MAPPING_FIELDS.map((field) => (
                  <label key={field.key}><span><strong>{field.label}</strong><small>{field.hint}</small></span><select value={mapping[field.key]} onChange={(event) => setMapping((current) => ({ ...current, [field.key]: event.target.value }))}>
                    <option value="">不使用</option>
                    {columns.map((column) => <option value={column} key={column}>{column}</option>)}
                  </select></label>
                ))}
              </div>
              <button className="data-text-button" type="button" onClick={applyMapping} disabled={!rawValues || loading === "analyze"}><RefreshCw size={14} />按当前映射重新分析</button>
            </section>

            <div className="data-insight-grid">
              <section className="data-distribution-section">
                <header><strong>主要分布</strong><small>按当前字段映射汇总</small></header>
                {report.distributions.length === 0 ? <div className="data-section-empty">映射客户、状态或线路字段后显示分布</div> : report.distributions.map((group) => (
                  <div className="data-distribution" key={group.field}>
                    <strong>{group.field}</strong>
                    {group.items.map((item) => (
                      <div className="data-bar-row" key={item.label}>
                        <span title={item.label}>{item.label}</span>
                        <i><b style={{ width: `${Math.max(item.percent, 3)}%` }} /></i>
                        <em>{item.count}</em>
                      </div>
                    ))}
                  </div>
                ))}
              </section>

              <section className="data-anomaly-section">
                <header><div><strong>异常与复核</strong><small>同步后自动检查数据质量</small></div><span>{report.anomalies.length}</span></header>
                {report.anomalies.length === 0 ? (
                  <div className="data-quality-ok"><CheckCircle2 size={20} /><span><strong>暂未发现明显异常</strong><small>字段完整性和格式检查已完成</small></span></div>
                ) : (
                  <div className="data-anomaly-list">
                    {report.anomalies.map((item, index) => (
                      <article className={item.severity} key={`${item.title}-${index}`}>
                        <AlertTriangle size={16} /><span><strong>{item.title}</strong><small>{item.detail}</small></span><em>{item.count}</em>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <section className="data-columns-section">
              <header><div><strong>字段质量</strong><small>{report.columnCount} 个字段 · {report.rows} 条记录</small></div><button className="data-ai-button" type="button" onClick={sendToAi}><Send size={15} />交给 AI 深入分析</button></header>
              <div className="data-column-table">
                <div className="data-column-row head"><span>字段</span><span>类型</span><span>缺失</span><span>唯一值</span><span>示例</span></div>
                {report.columns.map((column) => (
                  <div className="data-column-row" key={column.name}>
                    <strong>{column.name}</strong><span>{kindLabel(column.kind)}</span><span className={column.missingPct >= 20 ? "warn" : ""}>{column.missingPct}%</span><span>{column.unique}</span><span title={column.sample.join(" / ")}>{column.sample.join(" / ") || "—"}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="data-sample-section">
              <header><strong>数据预览</strong><small>仅显示前 {report.sampleRows.length} 行</small></header>
              <div className="data-sample-scroll"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{report.sampleRows.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column}>{String(row[column] ?? "")}</td>)}</tr>)}</tbody></table></div>
            </section>
          </div>
        )}

        <footer className="data-page-footer"><ShieldCheck size={13} />只读访问 · 凭据保存在 Windows 凭据库 · <button type="button" onClick={() => window.open("https://open.feishu.cn/app", "_blank")}><ExternalLink size={12} />飞书开放平台</button></footer>
      </section>
    </>
  );
}
