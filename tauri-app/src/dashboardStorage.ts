const DATABASE_NAME = "ht-logistics-workspace";
const DATABASE_VERSION = 1;
const SNAPSHOT_STORE = "dashboard-snapshots";

export interface DashboardSnapshot<T> {
  dashboardId: string;
  report: T;
  sourceType: "base" | "local";
  savedAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
        database.createObjectStore(SNAPSHOT_STORE, { keyPath: "dashboardId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本地看板仓库"));
  });
}

async function runStoreRequest<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SNAPSHOT_STORE, mode);
    const request = operation(transaction.objectStore(SNAPSHOT_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地看板仓库操作失败"));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("本地看板仓库事务失败"));
    };
  });
}

export function loadDashboardSnapshot<T>(dashboardId: string): Promise<DashboardSnapshot<T> | undefined> {
  return runStoreRequest<DashboardSnapshot<T> | undefined>("readonly", (store) => store.get(dashboardId));
}

export function saveDashboardSnapshot<T>(snapshot: DashboardSnapshot<T>): Promise<IDBValidKey> {
  return runStoreRequest<IDBValidKey>("readwrite", (store) => store.put(snapshot));
}

export function deleteDashboardSnapshot(dashboardId: string): Promise<undefined> {
  return runStoreRequest<undefined>("readwrite", (store) => store.delete(dashboardId));
}
