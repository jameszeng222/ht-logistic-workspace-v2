import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, BarChart3, CheckCircle2, Database, LoaderCircle, RefreshCw, Settings2 } from "lucide-react";
import { loadDashboardSnapshot, saveDashboardSnapshot } from "./dashboardStorage";
import { TransferControlTower, type TransferControlTowerReport } from "./TransferControlTower";
import {
  activeDashboardId as getActiveDashboardId,
  loadDashboardConfigs,
  saveActiveDashboardId,
  saveDashboardConfigs,
  type TransferDashboardConfig,
} from "./transferDashboardConfig";

interface Props {
  onOpenConfig: () => void;
  onSendToAssistant: (message: string) => void;
}

export function TransferDashboardPanel({ onOpenConfig, onSendToAssistant }: Props) {
  const [dashboards, setDashboards] = useState<TransferDashboardConfig[]>(loadDashboardConfigs);
  const [activeId, setActiveId] = useState(() => getActiveDashboardId(dashboards));
  const [report, setReport] = useState<TransferControlTowerReport | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const syncingRef = useRef(false);

  const activeDashboard = useMemo(
    () => dashboards.find((dashboard) => dashboard.id === activeId) || dashboards[0],
    [activeId, dashboards],
  );

  useEffect(() => {
    saveDashboardConfigs(dashboards);
  }, [dashboards]);

  const loadSnapshot = useCallback(async (dashboardId: string) => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await loadDashboardSnapshot<TransferControlTowerReport>(dashboardId);
      if (!mountedRef.current) return;
      setReport(snapshot?.report || null);
      setSavedAt(snapshot?.savedAt || null);
    } catch (reason) {
      if (mountedRef.current) setError(`读取本地看板失败：${String(reason)}`);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    saveActiveDashboardId(activeId);
    loadSnapshot(activeId);
    const onUpdated = (event: Event) => {
      const dashboardId = (event as CustomEvent<{ dashboardId?: string }>).detail?.dashboardId;
      if (!dashboardId || dashboardId === activeId) loadSnapshot(activeId);
    };
    window.addEventListener("transfer-dashboard-updated", onUpdated);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("transfer-dashboard-updated", onUpdated);
    };
  }, [activeId, loadSnapshot]);

  const syncDashboard = useCallback(async (background = false) => {
    if (syncingRef.current) return;
    if (!activeDashboard.source.url || !activeDashboard.source.tableId) {
      if (!background) setError("请先到数据配置中选择飞书多维表格和数据表");
      return;
    }
    syncingRef.current = true;
    setSyncing(true);
    if (!background) setError(null);
    try {
      const connection = await invoke<{ configured: boolean }>("get_feishu_connection");
      if (!connection.configured) throw new Error("飞书应用尚未连接，请先到数据配置保存 App ID 和 App Secret");
      const result = await invoke<{ values: unknown[][]; tableName?: string }>("feishu_fetch_base", {
        baseUrl: activeDashboard.source.url,
        tableId: activeDashboard.source.tableId,
        viewId: activeDashboard.source.viewId || null,
        tableName: activeDashboard.source.tableName || activeDashboard.name,
      });
      const values = Array.isArray(result.values) ? result.values : [];
      if (values.length < 2) throw new Error("数据表中没有可分析的记录，请检查数据表或视图权限");
      const sidecar = await invoke<{ url?: string }>("sidecar_status").catch(() => ({ url: "http://127.0.0.1:8000" }));
      const response = await fetch(`${sidecar.url || "http://127.0.0.1:8000"}/api/logistics-data/control-tower/values`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          values,
          source_name: result.tableName || activeDashboard.source.tableName || activeDashboard.name,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || `分析服务返回 ${response.status}`);
      const nextReport = payload as TransferControlTowerReport;
      const nextSavedAt = Date.now();
      await saveDashboardSnapshot({ dashboardId: activeDashboard.id, report: nextReport, sourceType: "base", savedAt: nextSavedAt });
      const nextDashboards = dashboards.map((dashboard) => dashboard.id === activeDashboard.id
        ? { ...dashboard, lastSync: nextSavedAt }
        : dashboard);
      saveDashboardConfigs(nextDashboards);
      if (!mountedRef.current) return;
      setDashboards(nextDashboards);
      setReport(nextReport);
      setSavedAt(nextSavedAt);
      setError(null);
    } catch (reason) {
      if (!background && mountedRef.current) setError(`同步失败：${String(reason)}`);
    } finally {
      syncingRef.current = false;
      if (mountedRef.current) setSyncing(false);
    }
  }, [activeDashboard, dashboards]);

  useEffect(() => {
    if (!activeDashboard.autoSync || !activeDashboard.source.tableId) return;
    const interval = activeDashboard.intervalMinutes * 60 * 1000;
    const due = !activeDashboard.lastSync || Date.now() - activeDashboard.lastSync >= interval;
    const initialTimer = due ? window.setTimeout(() => syncDashboard(true), 4_000) : undefined;
    const timer = window.setInterval(() => syncDashboard(true), interval);
    return () => {
      if (initialTimer) window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [activeDashboard.autoSync, activeDashboard.intervalMinutes, activeDashboard.lastSync, activeDashboard.source.tableId, syncDashboard]);

  return (
    <section className="transfer-dashboard-page" aria-label="调拨数据看板">
      <header className="transfer-dashboard-header">
        <div className="transfer-dashboard-title">
          <span><BarChart3 size={20} /></span>
          <div><small>TRANSFER OPERATIONS</small><h1>{activeDashboard.name || "调拨数据看板"}</h1><p>{report?.sourceName || activeDashboard.source.tableName || "等待配置数据来源"}</p></div>
        </div>
        <div className="transfer-dashboard-actions">
          {dashboards.length > 1 && <select value={activeId} onChange={(event) => setActiveId(event.target.value)} aria-label="切换看板">{dashboards.map((dashboard) => <option key={dashboard.id} value={dashboard.id}>{dashboard.name}</option>)}</select>}
          {savedAt && <span><CheckCircle2 size={14} />{new Date(savedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>}
          <button type="button" onClick={() => syncDashboard(false)} disabled={syncing} title="同步最新数据">{syncing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button>
          <button type="button" onClick={onOpenConfig} title="数据配置"><Settings2 size={16} /></button>
        </div>
      </header>

      {error && <div className="data-error"><AlertTriangle size={17} /><span>{error}</span><button type="button" onClick={() => setError(null)}>×</button></div>}

      {loading ? (
        <div className="transfer-dashboard-empty"><LoaderCircle className="spin" size={25} /><strong>正在读取固化看板</strong></div>
      ) : report ? (
        <TransferControlTower report={report} onSendToAssistant={onSendToAssistant} />
      ) : (
        <div className="transfer-dashboard-empty">
          <span><Database size={26} /></span>
          <strong>还没有固化的看板数据</strong>
          <p>先完成一次本地 Excel 导入或飞书同步，之后每次进入都会直接显示上次结果。</p>
          <button type="button" onClick={onOpenConfig}><Settings2 size={15} />前往数据配置</button>
        </div>
      )}
    </section>
  );
}
