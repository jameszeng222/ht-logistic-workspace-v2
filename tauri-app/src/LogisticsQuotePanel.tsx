import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, CheckCircle2, CircleDollarSign, Database, LoaderCircle, RefreshCw, Settings2 } from "lucide-react";
import { loadDashboardSnapshot, saveDashboardSnapshot } from "./dashboardStorage";
import { LogisticsQuoteDashboard, type LogisticsQuoteReport } from "./LogisticsQuoteDashboard";
import { loadDashboardConfigs, saveDashboardConfigs, type TransferDashboardConfig } from "./transferDashboardConfig";
import { isWebPreview, WEB_PREVIEW_QUOTE_REPORT } from "./webPreview";

interface Props {
  onOpenConfig: () => void;
  onSendToAssistant: (message: string) => void;
}

export function LogisticsQuotePanel({ onOpenConfig, onSendToAssistant }: Props) {
  const [dashboard, setDashboard] = useState<TransferDashboardConfig>(() => loadDashboardConfigs().find((item) => item.kind === "quote")!);
  const [report, setReport] = useState<LogisticsQuoteReport | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const syncingRef = useRef(false);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await loadDashboardSnapshot<LogisticsQuoteReport>(dashboard.id);
      setReport(snapshot?.report || (isWebPreview ? WEB_PREVIEW_QUOTE_REPORT : null));
      setSavedAt(snapshot?.savedAt || (isWebPreview ? Date.parse(WEB_PREVIEW_QUOTE_REPORT.updatedAt) : null));
    } catch (reason) {
      setError(`读取本地报价看板失败：${String(reason)}`);
    } finally {
      setLoading(false);
    }
  }, [dashboard.id]);

  useEffect(() => { loadSnapshot(); }, [loadSnapshot]);
  useEffect(() => {
    const onUpdated = (event: Event) => {
      const dashboardId = (event as CustomEvent<{ dashboardId?: string }>).detail?.dashboardId;
      if (!dashboardId || dashboardId === dashboard.id) {
        const latest = loadDashboardConfigs().find((item) => item.kind === "quote");
        if (latest) setDashboard(latest);
        loadSnapshot();
      }
    };
    window.addEventListener("dashboard-updated", onUpdated);
    return () => window.removeEventListener("dashboard-updated", onUpdated);
  }, [dashboard.id, loadSnapshot]);

  const syncDashboard = useCallback(async (background = false) => {
    if (syncingRef.current) return;
    if (isWebPreview) {
      if (!background) setError("在线预览不连接本地飞书服务；桌面版中可同步真实数据。");
      return;
    }
    if (!dashboard.source.url || !dashboard.source.tableId) {
      if (!background) setError("请先到数据配置中选择大货运费表");
      return;
    }
    syncingRef.current = true;
    setSyncing(true);
    if (!background) setError(null);
    try {
      const connection = await invoke<{ configured: boolean }>("get_feishu_connection");
      if (!connection.configured) throw new Error("飞书应用尚未连接，请先到数据配置保存 App ID 和 App Secret");
      const result = await invoke<{ values: unknown[][]; tableName?: string }>("feishu_fetch_base", {
        baseUrl: dashboard.source.url,
        tableId: dashboard.source.tableId,
        viewId: dashboard.source.viewId || null,
        tableName: dashboard.source.tableName || "大货运费表",
        dataKind: "quote",
      });
      if (!Array.isArray(result.values) || result.values.length < 2) throw new Error("大货运费表中没有可分析的记录");
      const sidecar = await invoke<{ url?: string }>("sidecar_status").catch(() => ({ url: "http://127.0.0.1:8000" }));
      const response = await fetch(`${sidecar.url || "http://127.0.0.1:8000"}/api/logistics-data/quote/values`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: result.values, source_name: result.tableName || dashboard.source.tableName || "大货运费表" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || `分析服务返回 ${response.status}`);
      const nextReport = payload as LogisticsQuoteReport;
      const nextSavedAt = Date.now();
      await saveDashboardSnapshot({ dashboardId: dashboard.id, report: nextReport, sourceType: "base", savedAt: nextSavedAt });
      const dashboards = loadDashboardConfigs().map((item) => item.id === dashboard.id ? { ...item, lastSync: nextSavedAt } : item);
      saveDashboardConfigs(dashboards);
      setDashboard(dashboards.find((item) => item.id === dashboard.id) || dashboard);
      setReport(nextReport);
      setSavedAt(nextSavedAt);
      setError(null);
    } catch (reason) {
      if (!background) setError(`同步失败：${String(reason)}`);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [dashboard]);

  useEffect(() => {
    if (!dashboard.autoSync || !dashboard.source.tableId) return;
    const interval = dashboard.intervalMinutes * 60 * 1000;
    const due = !dashboard.lastSync || Date.now() - dashboard.lastSync >= interval;
    const initialTimer = due ? window.setTimeout(() => syncDashboard(true), 4_000) : undefined;
    const timer = window.setInterval(() => syncDashboard(true), interval);
    return () => { if (initialTimer) window.clearTimeout(initialTimer); window.clearInterval(timer); };
  }, [dashboard.autoSync, dashboard.intervalMinutes, dashboard.lastSync, dashboard.source.tableId, syncDashboard]);

  const sourceName = useMemo(() => report?.sourceName || dashboard.source.tableName || "大货运费表", [dashboard.source.tableName, report?.sourceName]);
  return <section className="transfer-dashboard-page quote-dashboard-page" aria-label="物流报价看板">
    <header className="transfer-dashboard-header">
      <div className="transfer-dashboard-title"><span><CircleDollarSign size={20} /></span><div><small>LOGISTICS QUOTATION</small><h1>物流报价</h1><p>{sourceName}</p></div></div>
      <div className="transfer-dashboard-actions">
        {savedAt && <span><CheckCircle2 size={14} />{new Date(savedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>}
        <button type="button" onClick={() => syncDashboard(false)} disabled={syncing} title="同步最新报价">{syncing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button>
        <button type="button" onClick={onOpenConfig} title="数据配置"><Settings2 size={16} /></button>
      </div>
    </header>
    {error && <div className="data-error"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)}>×</button></div>}
    {loading ? <div className="transfer-dashboard-empty"><LoaderCircle className="spin" size={25} /><strong>正在读取固化报价</strong></div> : report ? <LogisticsQuoteDashboard report={report} onSendToAssistant={onSendToAssistant} /> : <div className="transfer-dashboard-empty"><span><Database size={26} /></span><strong>还没有固化的报价数据</strong><p>首次同步“大货运费表”后，这里会直接保留并展示上次结果。</p><button type="button" onClick={() => syncDashboard(false)}><RefreshCw size={15} />首次同步</button></div>}
  </section>;
}
