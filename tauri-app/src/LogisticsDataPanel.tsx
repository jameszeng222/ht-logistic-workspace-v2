import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TransferControlTowerReport } from "./TransferControlTower";
import { deleteDashboardSnapshot, loadDashboardSnapshot, saveDashboardSnapshot } from "./dashboardStorage";
import {
  ACTIVE_DASHBOARD_KEY,
  BASE_SOURCE_KEY,
  DASHBOARDS_KEY,
  activeDashboardId as getActiveDashboardId,
  createDashboardId,
  loadBaseSourceConfig,
  loadDashboardConfigs,
  type BaseSourceConfig,
  type DashboardKind,
  type TransferDashboardConfig,
} from "./transferDashboardConfig";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  CloudDownload,
  Database,
  ExternalLink,
  FileSpreadsheet,
  KeyRound,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
  X,
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

interface FeishuBaseTable {
  table_id: string;
  name: string;
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
  onOpenDashboard: (kind: DashboardKind) => void;
  compact?: boolean;
  onClose?: () => void;
}

interface StoredDashboardReport { rows: number; sourceName?: string }

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

function loadSource(): SourceConfig {
  try {
    const stored = JSON.parse(localStorage.getItem(SOURCE_KEY) || "null");
    if (stored && typeof stored.name === "string" && typeof stored.url === "string") {
      return {
        name: stored.name === "业务数据表" ? "" : stored.name,
        url: stored.url,
        sheetId: typeof stored.sheetId === "string" ? stored.sheetId : "",
        range: stored.range === "A1:Z2000" ? "" : (typeof stored.range === "string" ? stored.range : ""),
      };
    }
  } catch { /* ignore invalid local preferences */ }
  return { name: "", url: "", sheetId: "", range: "" };
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

export function LogisticsDataPanel({ onSendToAssistant, onOpenDashboard, compact = false, onClose }: LogisticsDataPanelProps) {
  const [dashboards, setDashboards] = useState<TransferDashboardConfig[]>(loadDashboardConfigs);
  const [activeDashboardId, setActiveDashboardId] = useState(() => {
    return getActiveDashboardId(dashboards);
  });
  const activeDashboard = dashboards.find((dashboard) => dashboard.id === activeDashboardId) || dashboards[0];
  const [connection, setConnection] = useState<FeishuConnection>({ configured: false, appId: null });
  const [showCredentials, setShowCredentials] = useState(false);
  const [showBaseSource, setShowBaseSource] = useState(true);
  const [showSheetSource, setShowSheetSource] = useState(false);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [source, setSource] = useState<SourceConfig>(loadSource);
  const [baseSource, setBaseSource] = useState<BaseSourceConfig>(activeDashboard.source);
  const [sheets, setSheets] = useState<FeishuSheet[]>([]);
  const [baseTables, setBaseTables] = useState<FeishuBaseTable[]>([]);
  const [mapping, setMapping] = useState<FieldMapping>(EMPTY_MAPPING);
  const [rawValues, setRawValues] = useState<unknown[][] | null>(null);
  const [report, setReport] = useState<LogisticsReport | null>(null);
  const [towerReport, setTowerReport] = useState<StoredDashboardReport | null>(null);
  const [localFile, setLocalFile] = useState<File | null>(null);
  const [activeSource, setActiveSource] = useState<"local" | "base" | "sheet" | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(activeDashboard.lastSync);
  const [loading, setLoading] = useState<"credentials" | "sheets" | "base-tables" | "sync" | "analyze" | "workbook" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const syncingRef = useRef(false);
  const activeDashboardIdRef = useRef(activeDashboardId);
  const baseSourceDashboardIdRef = useRef(activeDashboardId);
  const dashboardsRef = useRef(dashboards);

  const updateActiveDashboard = useCallback((patch: Partial<TransferDashboardConfig>) => {
    setDashboards((current) => current.map((dashboard) => (
      dashboard.id === activeDashboardId ? { ...dashboard, ...patch } : dashboard
    )));
  }, [activeDashboardId]);

  useEffect(() => {
    invoke<FeishuConnection>("get_feishu_connection")
      .then((value) => {
        setConnection(value);
        if (value.appId) setAppId(value.appId);
        setShowCredentials(false);
      })
      .catch(() => setShowCredentials(false));
  }, []);

  useEffect(() => {
    localStorage.setItem(SOURCE_KEY, JSON.stringify(source));
  }, [source]);

  useEffect(() => {
    localStorage.setItem(BASE_SOURCE_KEY, JSON.stringify(baseSource));
    if (baseSourceDashboardIdRef.current !== activeDashboardId) return;
    updateActiveDashboard({ source: baseSource });
  }, [activeDashboardId, baseSource, updateActiveDashboard]);

  useEffect(() => {
    localStorage.setItem(DASHBOARDS_KEY, JSON.stringify(dashboards));
    dashboardsRef.current = dashboards;
  }, [dashboards]);

  useEffect(() => {
    activeDashboardIdRef.current = activeDashboardId;
    localStorage.setItem(ACTIVE_DASHBOARD_KEY, activeDashboardId);
    const dashboard = dashboards.find((item) => item.id === activeDashboardId) || dashboards[0];
    baseSourceDashboardIdRef.current = activeDashboardId;
    setBaseSource(dashboard.source);
    setBaseTables([]);
    setLastSync(dashboard.lastSync);
    setTowerReport(null);
    setReport(null);
    setLocalFile(null);
    setActiveSource(dashboard.source.tableId ? "base" : null);
    setError(null);
    loadDashboardSnapshot<StoredDashboardReport>(activeDashboardId)
      .then((snapshot) => {
        if (!snapshot || activeDashboardIdRef.current !== activeDashboardId) return;
        setTowerReport(snapshot.report);
        setActiveSource(snapshot.sourceType);
        setLastSync(snapshot.savedAt);
      })
      .catch(() => { /* a missing local snapshot should not block live sync */ });
  }, [activeDashboardId]);

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

  const createDashboard = useCallback(() => {
    const next: TransferDashboardConfig = {
      id: createDashboardId(),
      name: `调拨数据看板 ${dashboards.length + 1}`,
      kind: "transfer",
      source: { url: "", tableId: "", tableName: "", viewId: "" },
      autoSync: true,
      intervalMinutes: 60,
      lastSync: null,
    };
    setDashboards((current) => [...current, next]);
    setActiveDashboardId(next.id);
    setShowBaseSource(true);
  }, [dashboards.length]);

  const removeDashboard = useCallback(async () => {
    if (dashboards.length <= 1) return;
    const index = dashboards.findIndex((dashboard) => dashboard.id === activeDashboardId);
    const fallback = dashboards[Math.max(0, index - 1)] || dashboards[0];
    setDashboards((current) => current.filter((dashboard) => dashboard.id !== activeDashboardId));
    setActiveDashboardId(fallback.id);
    try { await deleteDashboardSnapshot(activeDashboardId); } catch { /* best effort */ }
  }, [activeDashboardId, dashboards]);

  const persistTowerReport = useCallback(async (
    nextReport: StoredDashboardReport,
    sourceType: "base" | "local",
    savedAt: number,
    targetDashboardId: string,
  ) => {
    await saveDashboardSnapshot({ dashboardId: targetDashboardId, report: nextReport, sourceType, savedAt });
    setDashboards((current) => current.map((dashboard) => (
      dashboard.id === targetDashboardId ? { ...dashboard, lastSync: savedAt } : dashboard
    )));
    window.dispatchEvent(new CustomEvent("dashboard-updated", { detail: { dashboardId: targetDashboardId } }));
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
    setBaseTables([]);
    setShowCredentials(true);
  }, []);

  const loadBaseTables = useCallback(async () => {
    if (!baseSource.url.trim()) {
      setError("请先粘贴飞书多维表格链接");
      return;
    }
    setLoading("base-tables");
    setError(null);
    try {
      const result = await invoke<{ tables: FeishuBaseTable[]; tableId?: string | null; viewId?: string | null }>("feishu_list_base_tables", { baseUrl: baseSource.url });
      const tables = Array.isArray(result.tables) ? result.tables : [];
      setBaseTables(tables);
      const preferredNameByKind = activeDashboard.kind === "quote" ? "大货运费表" : "调拨时效表（箱维度）";
      const preferred = result.tableId && tables.some((table) => table.table_id === result.tableId)
        ? result.tableId
        : tables.find((table) => table.name === preferredNameByKind)?.table_id || tables[0]?.table_id || "";
      const preferredName = tables.find((table) => table.table_id === preferred)?.name || "";
      setBaseSource((current) => ({ ...current, tableId: preferred, tableName: preferredName, viewId: result.viewId || current.viewId }));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(null);
    }
  }, [activeDashboard.kind, baseSource.url]);

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
      setTowerReport(null);
      setLocalFile(null);
      setActiveSource("sheet");
      await analyze(values, nextMapping, source.name || "飞书表格");
    } catch (reason) {
      setError(String(reason));
      setLoading(null);
    }
  }, [analyze, source]);

  const syncDashboard = useCallback(async (dashboard: TransferDashboardConfig, background = false) => {
    const sourceConfig = dashboard.source;
    const isActive = activeDashboardIdRef.current === dashboard.id;
    if (!sourceConfig.url.trim() || !sourceConfig.tableId) {
      if (!background && isActive) setError("请先读取并选择多维表格中的数据表");
      return;
    }
    if (syncingRef.current) {
      if (!background && isActive) setError("已有同步任务正在运行，请稍候再试");
      return;
    }
    syncingRef.current = true;
    if (!background && isActive) setLoading("sync");
    if (isActive) setError(null);
    try {
      const result = await invoke<{ values: unknown[][]; tableName?: string }>("feishu_fetch_base", {
        baseUrl: sourceConfig.url,
        tableId: sourceConfig.tableId,
        viewId: sourceConfig.viewId || null,
        tableName: sourceConfig.tableName || dashboard.name || "飞书多维表格",
        dataKind: dashboard.kind,
      });
      const values = Array.isArray(result.values) ? result.values : [];
      if (values.length < 2) throw new Error("数据表中没有可分析的记录，请检查所选数据表或视图权限");
      const baseUrl = await sidecarUrl();
      const endpoint = dashboard.kind === "quote" ? "/api/logistics-data/quote/values" : "/api/logistics-data/control-tower/values";
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values, source_name: result.tableName || sourceConfig.tableName || dashboard.name || "飞书多维表格" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || `分析服务返回 ${response.status}`);
      const nextReport = payload as StoredDashboardReport;
      const syncedAt = Date.now();
      await persistTowerReport(nextReport, "base", syncedAt, dashboard.id);
      if (activeDashboardIdRef.current === dashboard.id) {
        setTowerReport(nextReport);
        setReport(null);
        setLocalFile(null);
        setActiveSource("base");
        setLastSync(syncedAt);
      }
    } catch (reason) {
      if (activeDashboardIdRef.current === dashboard.id) setError(`同步飞书多维表格失败：${String(reason)}`);
    } finally {
      syncingRef.current = false;
      if (!background) setLoading(null);
    }
  }, [persistTowerReport, sidecarUrl]);

  const syncBase = useCallback(
    (background = false) => syncDashboard({ ...activeDashboard, source: baseSource }, background),
    [activeDashboard, baseSource, syncDashboard],
  );

  useEffect(() => {
    if (!connection.configured) return;
    let cancelled = false;
    const syncDueDashboards = async () => {
      for (const dashboard of dashboardsRef.current) {
        if (cancelled || !dashboard.autoSync || !dashboard.source.url || !dashboard.source.tableId) continue;
        const interval = dashboard.intervalMinutes * 60 * 1000;
        if (dashboard.lastSync && Date.now() - dashboard.lastSync < interval) continue;
        await syncDashboard(dashboard, true);
      }
    };
    const initialTimer = window.setTimeout(syncDueDashboards, 3_000);
    const timer = window.setInterval(syncDueDashboards, 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [connection.configured, syncDashboard]);

  const applyMapping = useCallback(() => {
    if (rawValues) analyze(rawValues, mapping, report?.sourceName || source.name);
  }, [analyze, mapping, rawValues, report?.sourceName, source.name]);

  const loadWorkbook = useCallback(async (file: File) => {
    setLoading("workbook");
    setError(null);
    try {
      const baseUrl = await sidecarUrl();
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(`${baseUrl}/api/logistics-data/control-tower`, { method: "POST", body: formData });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || `读取服务返回 ${response.status}`);
      const nextReport = payload as TransferControlTowerReport;
      const syncedAt = Date.now();
      setLocalFile(file);
      setTowerReport(nextReport);
      setReport(null);
      setActiveSource("local");
      setLastSync(syncedAt);
      await persistTowerReport(nextReport, "local", syncedAt, activeDashboardId);
    } catch (reason) {
      setError(`读取 Excel 失败：${String(reason)}`);
    } finally {
      setLoading(null);
    }
  }, [activeDashboardId, persistTowerReport, sidecarUrl]);

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

  if (compact) {
    return (
      <section className="data-basic-config" aria-label="数据基础配置">
        <header className="data-basic-header">
          <div>
            <span><Database size={18} /></span>
            <div><strong>数据基础配置</strong><small>飞书连接、数据来源与自动同步</small></div>
          </div>
          <button type="button" onClick={onClose} title="关闭" aria-label="关闭数据配置"><X size={17} /></button>
        </header>

        <div className="data-basic-scroll">
          {error && <div className="data-error data-basic-error"><AlertTriangle size={16} /><span>{error}</span><button type="button" onClick={() => setError(null)}>×</button></div>}

          <label className="data-basic-field">
            <span>配置对象</span>
            <select value={activeDashboardId} onChange={(event) => setActiveDashboardId(event.target.value)} aria-label="选择数据看板">
              {dashboards.map((dashboard) => <option key={dashboard.id} value={dashboard.id}>{dashboard.name}</option>)}
            </select>
          </label>

          <section className={`data-basic-connection ${connection.configured ? "connected" : ""}`}>
            <div>
              <span>{connection.configured ? <ShieldCheck size={17} /> : <KeyRound size={17} />}</span>
              <div><strong>{connection.configured ? "飞书应用已连接" : "连接飞书应用"}</strong><small>{connection.configured ? connection.appId : "凭据仅保存在本机"}</small></div>
            </div>
            <button type="button" onClick={() => setShowCredentials((value) => !value)}>{showCredentials ? "收起" : connection.configured ? "修改" : "配置"}</button>
          </section>

          {showCredentials && <section className="data-basic-credentials">
            <label><span>App ID</span><input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_xxxxxxxxx" /></label>
            <label><span>App Secret</span><input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder={connection.configured ? "重新输入应用密钥" : "输入应用密钥"} /></label>
            <div>
              {connection.configured && <button className="data-text-button danger" type="button" onClick={clearCredentials}>清除连接</button>}
              <button className="data-primary-button compact" type="button" onClick={saveCredentials} disabled={loading === "credentials"}>
                {loading === "credentials" ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存连接
              </button>
            </div>
          </section>}

          <section className="data-basic-source">
            <label className="data-basic-field"><span>Wiki / Base 链接</span><div className="data-input-with-icon"><Link2 size={14} /><input value={baseSource.url} onChange={(event) => setBaseSource({ url: event.target.value, tableId: "", tableName: "", viewId: "" })} placeholder="粘贴飞书多维表格链接" /></div></label>
            <button className="data-secondary-button" type="button" onClick={loadBaseTables} disabled={!connection.configured || loading === "base-tables"}>
              {loading === "base-tables" ? <LoaderCircle className="spin" size={15} /> : <CloudDownload size={15} />}读取数据表
            </button>
            <label className="data-basic-field"><span>数据表</span><select value={baseSource.tableId} onChange={(event) => {
              const tableId = event.target.value;
              setBaseSource((current) => ({ ...current, tableId, tableName: baseTables.find((table) => table.table_id === tableId)?.name || "" }));
            }} disabled={!baseTables.length && !baseSource.tableId}>
              <option value="">{baseTables.length ? "选择数据表" : "连接后显示"}</option>
              {!baseTables.length && baseSource.tableId && <option value={baseSource.tableId}>{baseSource.tableName || "已保存的数据表"}</option>}
              {baseTables.map((table) => <option key={table.table_id} value={table.table_id}>{table.name}</option>)}
            </select></label>
          </section>

          <section className="data-basic-sync">
            <label><input type="checkbox" checked={activeDashboard.autoSync} onChange={(event) => updateActiveDashboard({ autoSync: event.target.checked })} /><span>自动同步</span></label>
            <select value={activeDashboard.intervalMinutes} onChange={(event) => updateActiveDashboard({ intervalMinutes: Number(event.target.value) })} disabled={!activeDashboard.autoSync} aria-label="自动同步频率">
              <option value={15}>每 15 分钟</option><option value={30}>每 30 分钟</option><option value={60}>每小时</option><option value={180}>每 3 小时</option><option value={360}>每 6 小时</option>
            </select>
          </section>
        </div>

        <footer className="data-basic-footer">
          <span>{baseSource.tableName || "尚未选择数据表"}</span>
          <div>
            <button className="data-secondary-button" type="button" onClick={onClose}>取消</button>
            <button className="data-primary-button compact" type="button" onClick={() => syncBase(false)} disabled={!connection.configured || !baseSource.tableId || loading === "sync"}>
              {loading === "sync" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}立即同步
            </button>
          </div>
        </footer>
      </section>
    );
  }

  return (
    <>
      <aside className="data-source-sidebar" aria-label="物流数据源">
        <header className="data-source-heading">
          <span><Database size={18} /></span>
          <div><strong>数据配置</strong><small>管理看板与同步来源</small></div>
          <button type="button" onClick={createDashboard} title="新建看板"><Plus size={15} /></button>
        </header>

        <div className="data-dashboard-picker">
          <select value={activeDashboardId} onChange={(event) => setActiveDashboardId(event.target.value)} aria-label="切换数据看板">
            {dashboards.map((dashboard) => <option key={dashboard.id} value={dashboard.id}>{dashboard.name}</option>)}
          </select>
        {dashboards.length > 1 && activeDashboard.kind !== "quote" && <button type="button" onClick={removeDashboard} title="删除当前看板"><Trash2 size={14} /></button>}
      </div>

        {activeDashboard.kind === "transfer" && <section className={`data-local-source ${towerReport ? "active" : ""}`}>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls" hidden onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) loadWorkbook(file);
            event.target.value = "";
          }} />
          <div><span><FileSpreadsheet size={17} /></span><div><strong>{localFile?.name || "调拨时效 Excel"}</strong><small>{towerReport ? `${towerReport.rows.toLocaleString("zh-CN")} 箱 · 已载入` : "使用本地文件生成看板"}</small></div></div>
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={loading === "workbook"}>
            {loading === "workbook" ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}{towerReport ? "更换" : "选择文件"}
          </button>
        </section>}

        <div className="data-sidebar-label">飞书数据源</div>

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

        <button className="data-sidebar-toggle" type="button" onClick={() => setShowBaseSource((value) => !value)}>
          <span>多维表格</span><ChevronDown className={showBaseSource ? "open" : ""} size={14} />
        </button>
        {showBaseSource && <section className="data-source-form data-base-source">
          <label><span>看板名称</span><input value={activeDashboard.name} onChange={(event) => updateActiveDashboard({ name: event.target.value })} placeholder={activeDashboard.kind === "quote" ? "例如：物流报价" : "例如：调拨时效"} /></label>
          <label><span>Wiki / Base 链接</span><div className="data-input-with-icon"><Link2 size={14} /><input value={baseSource.url} onChange={(event) => setBaseSource({ url: event.target.value, tableId: "", tableName: "", viewId: "" })} placeholder="粘贴飞书多维表格链接" /></div></label>
          <button className="data-secondary-button" type="button" onClick={loadBaseTables} disabled={!connection.configured || loading === "base-tables"}>
            {loading === "base-tables" ? <LoaderCircle className="spin" size={15} /> : <CloudDownload size={15} />}
            检查权限并读取数据表
          </button>
          <label><span>数据表</span><select value={baseSource.tableId} onChange={(event) => {
            const tableId = event.target.value;
            setBaseSource((current) => ({ ...current, tableId, tableName: baseTables.find((table) => table.table_id === tableId)?.name || "" }));
          }} disabled={!baseTables.length && !baseSource.tableId}>
            <option value="">{baseTables.length ? "选择数据表" : "连接后显示"}</option>
            {!baseTables.length && baseSource.tableId && <option value={baseSource.tableId}>{baseSource.tableName || "已保存的数据表"}</option>}
            {baseTables.map((table) => <option key={table.table_id} value={table.table_id}>{table.name}</option>)}
          </select></label>
          <div className="data-sync-schedule">
            <label><input type="checkbox" checked={activeDashboard.autoSync} onChange={(event) => updateActiveDashboard({ autoSync: event.target.checked })} /><span>自动同步</span></label>
            <select value={activeDashboard.intervalMinutes} onChange={(event) => updateActiveDashboard({ intervalMinutes: Number(event.target.value) })} disabled={!activeDashboard.autoSync} aria-label="自动同步频率">
              <option value={15}>每 15 分钟</option><option value={30}>每 30 分钟</option><option value={60}>每小时</option><option value={180}>每 3 小时</option><option value={360}>每 6 小时</option>
            </select>
          </div>
          <small className="data-sync-note">应用打开时自动全量校验 · 本地快照可即时查看</small>
          <button className="data-primary-button compact" type="button" onClick={() => syncBase(false)} disabled={!connection.configured || !baseSource.tableId || loading === "sync"}>
            {loading === "sync" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}立即同步
          </button>
        </section>}

        <button className="data-sidebar-toggle" type="button" onClick={() => setShowSheetSource((value) => !value)}>
          <span>普通电子表格</span><ChevronDown className={showSheetSource ? "open" : ""} size={14} />
        </button>
        {showSheetSource && <section className="data-source-form">
          <label><span>名称</span><input value={source.name} onChange={(event) => setSource((current) => ({ ...current, name: event.target.value }))} placeholder="可选" /></label>
          <label><span>飞书表格链接</span><div className="data-input-with-icon"><Link2 size={14} /><input value={source.url} onChange={(event) => setSource((current) => ({ ...current, url: event.target.value, sheetId: "" }))} placeholder="https://xxx.feishu.cn/sheets/..." /></div></label>
          <button className="data-secondary-button" type="button" onClick={loadSheets} disabled={!connection.configured || loading === "sheets"}>
            {loading === "sheets" ? <LoaderCircle className="spin" size={15} /> : <CloudDownload size={15} />}
            检查权限并读取工作表
          </button>
          <label><span>工作表</span><select value={source.sheetId} onChange={(event) => setSource((current) => ({ ...current, sheetId: event.target.value }))} disabled={sheets.length === 0}>
            <option value="">{sheets.length ? "选择工作表" : "连接后显示"}</option>
            {sheets.map((sheet) => <option key={sheetId(sheet)} value={sheetId(sheet)}>{sheet.title || sheetId(sheet)}</option>)}
          </select></label>
          <label><span>读取范围</span><input value={source.range} onChange={(event) => setSource((current) => ({ ...current, range: event.target.value }))} placeholder="可选，例如 A1:Z2000" /></label>
        </section>}

        <div className="data-sidebar-spacer" />
      </aside>

      <section className="logistics-data-page">
        <header className="data-page-header">
          <div>
            <span className="data-eyebrow">系统设置 / 数据来源</span>
            <h1>数据配置</h1>
            <p>在这里管理飞书连接、数据表、同步频率和多个业务看板。</p>
          </div>
          <div className="data-header-actions">
            {lastSync && <span className="data-last-sync"><CheckCircle2 size={14} />{new Date(lastSync).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 已更新</span>}
            <button className="data-secondary-button" type="button" onClick={() => onOpenDashboard(activeDashboard.kind)}><BarChart3 size={15} />打开{activeDashboard.kind === "quote" ? "报价" : "调拨"}看板</button>
          </div>
        </header>

        {error && <div className="data-error"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)}>×</button></div>}

        <div className="data-config-overview">
          <section className="data-config-current">
            <header>
              <span><Database size={20} /></span>
              <div><small>当前看板</small><h2>{activeDashboard.name || "调拨数据看板"}</h2><p>{baseSource.tableName || "尚未选择飞书数据表"}</p></div>
            </header>
            <div className="data-config-status-grid">
              <article className={connection.configured ? "ready" : ""}><ShieldCheck size={17} /><span><strong>飞书连接</strong><small>{connection.configured ? "已授权" : "未配置"}</small></span></article>
              <article className={baseSource.tableId ? "ready" : ""}><Link2 size={17} /><span><strong>数据来源</strong><small>{baseSource.tableId ? "已选择数据表" : "待选择"}</small></span></article>
              <article className={towerReport ? "ready" : ""}><BarChart3 size={17} /><span><strong>固化结果</strong><small>{towerReport ? `${towerReport.rows.toLocaleString("zh-CN")} 条` : "尚无快照"}</small></span></article>
              <article className={activeDashboard.autoSync ? "ready" : ""}><RefreshCw size={17} /><span><strong>定时同步</strong><small>{activeDashboard.autoSync ? `每 ${activeDashboard.intervalMinutes} 分钟` : "未开启"}</small></span></article>
            </div>
            <div className="data-config-actions">
              <button className="data-primary-button" type="button" onClick={() => syncBase(false)} disabled={!connection.configured || !baseSource.tableId || loading === "sync"}>
                {loading === "sync" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}同步并更新看板
              </button>
              <button className="data-secondary-button" type="button" onClick={() => onOpenDashboard(activeDashboard.kind)}><BarChart3 size={15} />查看固化结果</button>
            </div>
          </section>

          <section className="data-config-help">
            <strong>配置顺序</strong>
            <ol><li>保存飞书应用凭据</li><li>粘贴多维表格链接并读取数据表</li><li>选择同步频率后执行首次同步</li></ol>
            <p>首次同步成功后，看板会保存本地快照。以后打开应用可直接查看，不必等待飞书重新拉取。</p>
          </section>
        </div>

        <footer className="data-page-footer"><ShieldCheck size={13} />飞书只读访问 · 凭据保存在 Windows 凭据库 · <button type="button" onClick={() => window.open("https://open.feishu.cn/app", "_blank")}><ExternalLink size={12} />飞书开放平台</button></footer>
      </section>
    </>
  );
}
