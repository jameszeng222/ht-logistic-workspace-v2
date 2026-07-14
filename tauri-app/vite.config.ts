import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    open: false,
    // 必须忽略 .venv 和 target，否则 pip 装包/cargo 编译会触发 vite page reload，
    // 把 sidecar 进程搞乱，UI 一直显示"Sidecar 启动中…"。
    // vite 默认 ignore node_modules，但 .venv 和 target 在项目外，
    // 需要显式忽略（路径相对于 vite.config.ts 所在目录）。
    watch: {
      ignored: [
        "**/.venv/**",
        "**/target/**",
        "**/src-tauri/target/**",
        "**/node_modules/**",
      ],
    },
  },
});
