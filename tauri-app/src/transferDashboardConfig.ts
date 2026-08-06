export interface BaseSourceConfig {
  url: string;
  tableId: string;
  tableName: string;
  viewId: string;
}

export interface TransferDashboardConfig {
  id: string;
  name: string;
  source: BaseSourceConfig;
  autoSync: boolean;
  intervalMinutes: number;
  lastSync: number | null;
}

export const BASE_SOURCE_KEY = "ht-feishu-logistics-base-source";
export const DASHBOARDS_KEY = "ht-transfer-dashboards-v1";
export const ACTIVE_DASHBOARD_KEY = "ht-transfer-active-dashboard-v1";

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
      return stored.map((item, index) => ({
        id: typeof item.id === "string" ? item.id : createDashboardId(),
        name: typeof item.name === "string" && item.name.trim() ? item.name : `调拨数据看板 ${index + 1}`,
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
    }
  } catch { /* migrate to one default dashboard */ }
  return [{
    id: createDashboardId(),
    name: "调拨数据看板",
    source: loadBaseSourceConfig(),
    autoSync: true,
    intervalMinutes: 60,
    lastSync: null,
  }];
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
