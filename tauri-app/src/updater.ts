// 自动更新封装：检查 / 下载 / 安装 / 重启
// 基于 @tauri-apps/plugin-updater 和 plugin-process
// 手动触发模式（设置页"检查更新"按钮），不做启动时自动检查（后续再加）

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; currentVersion: string }
  | { kind: "available"; currentVersion: string; version: string; notes: string }
  | { kind: "downloading"; percent: number }
  | { kind: "installing" }
  | { kind: "done" }
  | { kind: "error"; message: string };

export interface UpdateController {
  status: UpdateStatus;
  checkForUpdate: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
}

/** 调用 plugin-updater 的 check()，返回 Update 对象或 null */
export async function checkUpdate() {
  return await check();
}

/** 下载并安装更新，progressCb 报告百分比 0-100。安装完成后调用 relaunch 重启。 */
export async function downloadAndInstallUpdate(
  onProgress: (percent: number) => void
): Promise<void> {
  const update = await check();
  if (!update) {
    throw new Error("没有可用的更新");
  }

  let total = 0;
  let downloaded = 0;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? 0;
        downloaded = 0;
        onProgress(0);
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress(total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0);
        break;
      case "Finished":
        onProgress(100);
        break;
    }
  });

  // 安装完成，重启应用
  await relaunch();
}
