export interface BaseSourceConfig {
  url: string;
  tableId: string;
  tableName: string;
  viewId: string;
}

export type DashboardKind = "transfer" | "quote";

export interface TransferDashboardConfig {
  id: string;
  name: string;
  kind: DashboardKind;
  source: BaseSourceConfig;
  autoSync: boolean;
  intervalMinutes: number;
  lastSync: number | null;
}

export const BASE_SOURCE_KEY = "ht-feishu-logistics-base-source";
export const DASHBOARDS_KEY = "ht-transfer-dashboards-v1";
export const ACTIVE_DASHBOARD_KEY = "ht-transfer-active-dashboard-v1";
export const QUOTE_DASHBOARD_ID = "logistics-quote-dashboard";
export const QUOTE_BASE_URL = "https://q1my9tkfihy.feishu.cn/wiki/ODF2wicfzi8cjtkfigLcGIBRn1f?from=from_copylink";
export const QUOTE_TABLE_ID = "tblPweuGqJhRMceB";

export function defaultTransferDashboard(): TransferDashboardConfig {
  return {
    id: createDashboardId(),
    name: "调拨数据看板",
    kind: "transfer",
    source: loadBaseSourceConfig(),
    autoSync: true,
    intervalMinutes: 60,
    lastSync: null,
  };
}

export function defaultQuoteDashboard(): TransferDashboardConfig {
  return {
    id: QUOTE_DASHBOARD_ID,
    name: "物流报价",
    kind: "quote",
    source: {
      url: QUOTE_BASE_URL,
      tableId: QUOTE_TABLE_ID,
      tableName: "大货运费表",
      viewId: "",
    },
    autoSync: true,
    intervalMinutes: 60,
    lastSync: null,
  };
}

export function createDashboardId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `dashboard-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function loadBaseSourceConfig(): BaseSourceConfig {
  try {
    const stored = JSON.parse(localStorage.getItem(BASE_SOURCE_KEY) || "null");
    if (stored && typeof stored.url === "string") {
      return {
        url: stored.url,
        tableId: typeof stored.tableId === "string" ? stored.tableId : "",
        tableName: typeof stored.tableName === "string" ? stored.tableName : "",
        viewId: typeof stored.viewId === "string" ? stored.viewId : "",
      };
    }
  } catch { /* migrate invalid preferences to an empty source */ }
  return { url: "", tableId: "", tableName: "", viewId: "" };
}

export function loadDashboardConfigs(): TransferDashboardConfig[] {
  try {
    const stored = JSON.parse(localStorage.getItem(DASHBOARDS_KEY) || "null");
    if (Array.isArray(stored) && stored.length) {
      const dashboards = stored.map((item, index) => ({
        id: typeof item.id === "string" ? item.id : createDashboardId(),
        name: typeof item.name === "string" && item.name.trim() ? item.name : `调拨数据看板 ${index + 1}`,
        kind: item.kind === "quote" ? "quote" as const : "transfer" as const,
        source: {
          url: typeof item.source?.url === "string" ? item.source.url : "",
          tableId: typeof item.source?.tableId === "string" ? item.source.tableId : "",
          tableName: typeof item.source?.tableName === "string" ? item.source.tableName : "",
          viewId: typeof item.source?.viewId === "string" ? item.source.viewId : "",
        },
        autoSync: item.autoSync !== false,
        intervalMinutes: [15, 30, 60, 180, 360].includes(Number(item.intervalMinutes)) ? Number(item.intervalMinutes) : 60,
        lastSync: typeof item.lastSync === "number" ? item.lastSync : null,
      }));
      if (!dashboards.some((dashboard) => dashboard.kind === "quote")) {
        dashboards.push(defaultQuoteDashboard());
      }
      if (!dashboards.some((dashboard) => dashboard.kind === "transfer")) {
        dashboards.unshift(defaultTransferDashboard());
      }
      return dashboards;
    }
  } catch { /* migrate to one default dashboard */ }
  return [defaultTransferDashboard(), defaultQuoteDashboard()];
}

export function activeDashboardId(dashboards: TransferDashboardConfig[]): string {
  const stored = localStorage.getItem(ACTIVE_DASHBOARD_KEY);
  return dashboards.some((dashboard) => dashboard.id === stored) ? stored as string : dashboards[0].id;
}

export function saveDashboardConfigs(dashboards: TransferDashboardConfig[]): void {
  localStorage.setItem(DASHBOARDS_KEY, JSON.stringify(dashboards));
}

export function saveActiveDashboardId(dashboardId: string): void {
  localStorage.setItem(ACTIVE_DASHBOARD_KEY, dashboardId);
}
