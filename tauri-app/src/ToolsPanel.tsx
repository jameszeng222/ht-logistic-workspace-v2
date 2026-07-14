// 工具区面板：用 Tauri 原生文件对话框选文件 → 调 FastAPI → 用原生对话框保存结果。
//
// 用 Tauri dialog 而非 HTML <input>/<a download>：
//   - HTML 拖拽在 Tauri webview 里 DataTransfer.files 经常为空
//   - <a download> 对 blob URL 在 webview 里经常无反应
//   - 原生对话框更可靠，且能拿到绝对路径，便于 AI 后续引用
//
// 后端：python-sidecar/main.py（FastAPI on 127.0.0.1:8000）

import { forwardRef, useCallback, useEffect, useMemo, useImperativeHandle, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";

export interface ToolDef {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  input: "excel" | "pdf";
  output: "zip" | "excel" | "json";
}

interface SidecarStatus {
  running: boolean;
  ready: boolean;
  url: string;
  error?: string;
}

interface ToolsPanelProps {
  onSendToAssistant?: (message: string) => void;
  /** 工具执行成功并保存输出文件后回调，路径交给 App 加入"工具输出"上下文 */
  onToolOutput?: (path: string, toolName: string) => void;
  /** 工具列表变化时上报，供 App 在左侧栏渲染导航 */
  onToolsChange?: (tools: ToolDef[]) => void;
  /** 当前选中工具变化时上报，供 App 高亮左侧栏导航 */
  onActiveToolChange?: (tool: ToolDef | null) => void;
  /** 隐藏内置工具导航（导航移到左侧栏时设 true，中间只留执行区） */
  hideNav?: boolean;
}

/**
 * ToolsPanel 对外暴露的命令式 API（通过 ref 调用）。
 * 用 useImperativeHandle 而非 props 传 state，避免：
 *   - state 同步时序问题（连续点击会被覆盖）
 *   - useEffect 依赖 tools 未加载时匹配失败
 *   - filePath 设置后清除按钮和 incomingFile 状态冲突
 * 每次 loadFile 调用都是独立命令，直接操作内部 state，可靠且可重复。
 */
export interface ToolsPanelHandle {
  /** 加载文件到工具区，按 toolKind 切换工具并填入 filePath */
  loadFile: (path: string, toolKind: "invoice" | "customs" | "customs-extract" | "data") => void;
  /** 按 id 切换当前工具（供左侧栏导航点击调用），清空文件与结果 */
  selectTool: (id: string) => void;
}

const INPUT_FILTERS: Record<ToolDef["input"], { name: string; extensions: string[] }[]> = {
  excel: [{ name: "Excel", extensions: ["xlsx", "xls"] }],
  pdf: [{ name: "PDF", extensions: ["pdf"] }],
};

const OUTPUT_FILTERS: Record<ToolDef["output"], { name: string; extensions: string[] }[]> = {
  zip: [{ name: "ZIP", extensions: ["zip"] }],
  excel: [{ name: "Excel", extensions: ["xlsx"] }],
  json: [{ name: "JSON", extensions: ["json"] }],
};

const OUTPUT_DEFAULT_NAME: Record<ToolDef["output"], string> = {
  zip: "result.zip",
  excel: "result.xlsx",
  json: "result.json",
};

const DAILY_TOOL_IDS = new Set(["invoice-packing", "data-analysis"]);

function workflowLabel(tool: ToolDef): string {
  if (tool.id === "invoice-packing") return "单据制作";
  if (tool.id === "data-analysis") return "数据分析";
  return "物流工具";
}

export const ToolsPanel = forwardRef<ToolsPanelHandle, ToolsPanelProps>(function ToolsPanel({ onSendToAssistant, onToolOutput, onToolsChange, onActiveToolChange, hideNav = false }, ref) {
  const [tools, setTools] = useState<ToolDef[]>([]);
  const [sidecarUrl, setSidecarUrl] = useState("http://127.0.0.1:8000");
  const [sidecarReady, setSidecarReady] = useState(false);
  const [sidecarError, setSidecarError] = useState<string | null>(null);

  const [activeTool, setActiveTool] = useState<ToolDef | null>(null);
  // filePath 用 Tauri dialog 拿到的绝对路径；fileBlob 是对应的 File 对象用于 multipart 上传
  const [filePath, setFilePath] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [jsonResult, setJsonResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 「让助手解读」去重：同一工具+同一输入+同一结果 10 秒内只发一次
  const lastReviewRef = useRef<{ key: string; time: number }>({ key: "", time: 0 });

  const visibleTools = useMemo(() => tools, [tools]);

  const askAssistantToReview = useCallback(() => {
    if (!activeTool || !onSendToAssistant) return;
    // 去重：同一工具+同一输入文件+同一结果的解读请求，10 秒内只发一次
    const reviewKey = `${activeTool.id}:${filePath || ""}:${savedPath || jsonResult?.slice(0, 100) || ""}`;
    const now = Date.now();
    const last = lastReviewRef.current;
    if (last.key === reviewKey && now - last.time < 10000) {
      return; // 10 秒内重复请求，忽略
    }
    lastReviewRef.current = { key: reviewKey, time: now };
    const inputLine = filePath ? `输入文件：${filePath}` : "没有记录输入文件。";
    const resultLine = savedPath
      ? `输出文件：${savedPath}`
      : `工具返回 JSON：\n${(jsonResult || "").slice(0, 12000)}`;
    onSendToAssistant(
      `我刚用「${activeTool.name}」执行了物流工具。\n${inputLine}\n${resultLine}\n请帮我检查结果、指出潜在风险，并给出下一步建议。`
    );
  }, [activeTool, filePath, jsonResult, onSendToAssistant, savedPath]);

  // ============ 加载工具列表 + 监听 sidecar 状态 ============
  const refreshTools = useCallback(async () => {
    if (!sidecarReady) return;
    try {
      const resp = await fetch(`${sidecarUrl}/api/tools`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const nextTools = (data.tools || []) as ToolDef[];
      setTools(nextTools);
      const preferred = nextTools.find((t) => DAILY_TOOL_IDS.has(t.id)) || nextTools[0];
      if (!activeTool && preferred) setActiveTool(preferred);
    } catch (e) {
      setError(`拉取工具列表失败：${e}`);
    }
  }, [sidecarUrl, sidecarReady, activeTool]);

  const checkStatus = useCallback(async () => {
    try {
      const st = await invoke<SidecarStatus>("sidecar_status");
      setSidecarReady(st.ready);
      if (st.url) setSidecarUrl(st.url);
    } catch (e) {
      setSidecarError(String(e));
    }
  }, []);

  useEffect(() => {
    checkStatus();
    let unlisten: UnlistenFn | undefined;
    (async () => {
      unlisten = await listen<SidecarStatus>("sidecar-status", (e) => {
        setSidecarReady(e.payload.ready);
        if (e.payload.url) setSidecarUrl(e.payload.url);
        if (e.payload.error) setSidecarError(e.payload.error);
        else setSidecarError(null);
      });
    })();
    return () => { unlisten?.(); };
  }, [checkStatus]);

  useEffect(() => { refreshTools(); }, [refreshTools]);

  // ============ 命令式 API：供外部 ref 调用 ============
  // loadFile(path, toolKind)：按 toolKind 找工具 → 切换 activeTool → 填入 filePath
  // selectTool(id)：按 id 切换 activeTool（供左侧栏导航点击调用），清空文件与结果
  // 每次调用都是独立命令，直接操作 state，无 useEffect 副作用链。
  useImperativeHandle(ref, () => ({
    loadFile: (path: string, toolKind: "invoice" | "customs" | "customs-extract" | "data") => {
      const p = path.trim();
      if (!p) return;
      // 按 toolKind 找对应工具
      const targetId = toolKind === "invoice"
        ? "invoice-packing"
        : toolKind === "customs"
        ? "customs-generator"
        : toolKind === "customs-extract"
        ? "customs-extractor"
        : "data-analysis";
      const matched = tools.find((t) => t.id === targetId) || null;
      if (matched) {
        setActiveTool(matched);
      } else {
        // 工具列表还没加载，按扩展名兜底匹配
        const ext = p.split(".").pop()?.toLowerCase() || "";
        const fallback = (ext === "xlsx" || ext === "xls")
          ? (tools.find((t) => t.id === "invoice-packing") || tools.find((t) => t.id === "data-analysis") || tools[0] || null)
          : (tools.find((t) => t.input === "pdf") || tools[0] || null);
        if (fallback) setActiveTool(fallback);
      }
      setFilePath(p);
      setSavedPath(null);
      setJsonResult(null);
      setError(null);
    },
    selectTool: (id: string) => {
      const matched = tools.find((t) => t.id === id) || null;
      if (!matched) return;
      setActiveTool(matched);
      setFilePath(null);
      setSavedPath(null);
      setJsonResult(null);
      setError(null);
    },
  }), [tools]);

  // 工具列表 / 选中工具变化时上报，供 App 在左侧栏渲染导航
  useEffect(() => { onToolsChange?.(tools); }, [tools, onToolsChange]);
  useEffect(() => { onActiveToolChange?.(activeTool); }, [activeTool, onActiveToolChange]);

  // ============ 选文件（Tauri 原生对话框）============
  const pickFile = useCallback(async () => {
    if (!activeTool) return;
    setError(null);
    setSavedPath(null);
    setJsonResult(null);
    try {
      const selected = await openDialog({
        multiple: false,
        filters: INPUT_FILTERS[activeTool.input],
      });
      if (typeof selected === "string" && selected) {
        setFilePath(selected);
      }
    } catch (e) {
      setError(`选文件失败：${e}`);
    }
  }, [activeTool]);

  // ============ 调用工具 ============
  const runTool = useCallback(async () => {
    if (!activeTool || !filePath || !sidecarReady) return;
    setRunning(true);
    setError(null);
    setSavedPath(null);
    setJsonResult(null);
    try {
      // 用 Tauri fs 插件读本地文件为字节数组，再包成 Blob 上传。
      // 不能用 fetch('file://...')：Tauri webview 默认禁止 file:// 协议（报 Failed to fetch）。
      let fileBlob: Blob;
      try {
        const bytes = await readFile(filePath);
        fileBlob = new Blob([bytes]);
      } catch (e) {
        throw new Error(`无法读取文件 ${filePath}：${e}。请确认路径正确。`);
      }

      const fd = new FormData();
      // FormData.append 需要 File 而非 Blob，用 File 构造器包一层带文件名
      const fileName = filePath.split(/[\\/]/).pop() || "upload";
      fd.append("file", new File([fileBlob], fileName), fileName);

      const resp = await fetch(`${sidecarUrl}${activeTool.endpoint}`, {
        method: "POST",
        body: fd,
      });
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const errBody = await resp.json();
          if (errBody.detail) msg = errBody.detail;
        } catch {}
        throw new Error(msg);
      }

      if (activeTool.output === "json") {
        // JSON 类型：直接展示，不弹保存对话框
        const data = await resp.json();
        setJsonResult(JSON.stringify(data, null, 2));
      } else {
        // 文件类型：弹保存对话框 → 写盘
        const resultBlob = await resp.blob();
        const defaultName = `${activeTool.id}-${new Date().toISOString().slice(0, 10)}.${OUTPUT_DEFAULT_NAME[activeTool.output].split(".")[1]}`;
        const savePath = await saveDialog({
          defaultPath: defaultName,
          filters: OUTPUT_FILTERS[activeTool.output],
        });
        if (!savePath) {
          setError("已取消保存。请重新执行工具并选择保存位置。");
          return;
        }
        // 用 Tauri 写文件：通过 invoke 调 Rust 命令 write_binary_file
        const buf = new Uint8Array(await resultBlob.arrayBuffer());
        await invoke("write_binary_file", { path: savePath, data: Array.from(buf) });
        setSavedPath(savePath);
        // 通知 App 加入"工具输出"上下文区
        if (onToolOutput) onToolOutput(savePath, activeTool?.name || "物流工具");
      }
    } catch (e) {
      setError(`工具执行失败：${e}`);
    } finally {
      setRunning(false);
    }
  }, [activeTool, filePath, sidecarUrl, sidecarReady]);

  return (
    <div className="tools-panel">
      {sidecarError && (
        <div className="tools-banner error">{sidecarError}</div>
      )}

      <div className="tools-body">
        {/* 内置导航：hideNav=true 时由左侧栏承载导航，中间只留执行区 */}
        {!hideNav && (
          <div className="tools-list">
            <div className="tools-list-title">日常流程</div>
            {visibleTools.length === 0 ? (
              <div className="tools-empty">
                {sidecarReady ? "未拉到工具列表" : "等待 sidecar 就绪…"}
              </div>
            ) : visibleTools.map((t) => (
              <button
                key={t.id}
                className={`tool-card ${activeTool?.id === t.id ? "active" : ""}`}
                onClick={() => { setActiveTool(t); setFilePath(null); setSavedPath(null); setJsonResult(null); setError(null); }}
              >
                <div className="tool-card-name">{t.name}</div>
                <div className="tool-card-desc">{t.description}</div>
                <div className="tool-card-meta">
                  <span>{workflowLabel(t)}</span>
                  <span>·</span>
                  <span>{t.input.toUpperCase()}</span>
                  <span>→</span>
                  <span>{t.output.toUpperCase()}</span>
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="tools-detail">
          {/* 顶行：左侧工具名（发票/箱单生成），右侧"工具执行区"标签 + Sidecar 状态
              原 .tools-header 独立行已合并到这里，省出的纵向空间还给上方聊天输出窗口 */}
          <div className="tool-detail-top">
            <div className="tool-detail-title">{activeTool ? activeTool.name : "工具执行区"}</div>
            <div className="tool-detail-status">
              <span className="tools-title-tag">工具执行区</span>
              <div className={`sidecar-status ${sidecarReady ? "ready" : "error"}`}>
                <span className="dot" />
                {sidecarReady ? "Sidecar 在线" : sidecarError ? "Sidecar 异常" : "Sidecar 启动中…"}
              </div>
            </div>
          </div>
          {activeTool ? (
            <>
              <div className="tool-detail-desc">{activeTool.description}</div>

              {/* 选文件区（点击弹原生对话框）*/}
              <div className="file-pick-zone" onClick={pickFile}>
                {filePath ? (
                  <div className="file-pick-info">
                    <div className="file-pick-icon fb-icon-badge excel">XLS</div>
                    <div className="file-pick-name">{filePath.split(/[\\/]/).pop()}</div>
                    <div className="file-pick-path">{filePath}</div>
                    <div className="file-pick-hint">点击重新选择</div>
                  </div>
                ) : (
                  <div className="file-pick-empty">
                    <div className="file-pick-icon fb-icon-badge dir">DIR</div>
                    <div>点击选择 {activeTool.input.toUpperCase()} 文件</div>
                    <div className="file-pick-accept">
                      支持：{INPUT_FILTERS[activeTool.input].map(f => f.extensions.join(", ")).join(", ")}
                    </div>
                  </div>
                )}
              </div>

              {/* 执行按钮 */}
              <div className="tool-actions">
                <button
                  className="btn-primary"
                  onClick={runTool}
                  disabled={!filePath || running || !sidecarReady}
                >
                  {running ? "执行中…" : "执行工具"}
                </button>
                {filePath && (
                  <button
                    className="btn-secondary"
                    onClick={() => { setFilePath(null); setSavedPath(null); setJsonResult(null); setError(null); }}
                  >清除</button>
                )}
              </div>

              {/* 错误（可展开看完整堆栈）*/}
              {error && (
                <div className="tool-error">
                  <div className="tool-error-title">❌ 错误</div>
                  <pre className="tool-error-detail">{error}</pre>
                </div>
              )}

              {/* 成功结果：文件类型 */}
              {savedPath && (
                <div className="tool-result">
                  <div className="tool-result-label">✓ 完成 — 结果已保存：</div>
                  <div className="tool-result-path">{savedPath}</div>
                  <button
                    className="btn-secondary"
                    onClick={() => invoke("open_in_explorer", { path: savedPath })}
                  >在文件夹中显示</button>
                  {onSendToAssistant && (
                    <button
                      className="btn-secondary"
                      onClick={askAssistantToReview}
                    >让助手解读</button>
                  )}
                </div>
              )}

              {/* 成功结果：JSON 类型（直接展示） */}
              {jsonResult && (
                <div className="tool-result">
                  <div className="tool-result-label">✓ 完成 — 分析结果：</div>
                  <pre className="tool-result-json">{jsonResult}</pre>
                  {onSendToAssistant && (
                    <button
                      className="btn-secondary"
                      onClick={askAssistantToReview}
                    >让助手解读</button>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="tools-empty">请从左侧选择一个工具</div>
          )}
        </div>
      </div>
    </div>
  );
});
