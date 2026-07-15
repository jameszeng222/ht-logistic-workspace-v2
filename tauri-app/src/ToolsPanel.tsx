import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileOutput,
  FileSearch,
  FileSpreadsheet,
  FolderOpen,
  Hash,
  LoaderCircle,
  PackageCheck,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Upload,
  Wrench,
  X,
} from "lucide-react";

export interface ToolDef {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  input: "excel" | "pdf" | "text";
  output: "zip" | "excel" | "json";
}

interface SidecarStatus {
  running: boolean;
  ready: boolean;
  url: string;
  error?: string;
}

interface RecentOutput {
  path: string;
  toolName: string;
  time: number;
}

interface ToolsPanelProps {
  onSendToAssistant?: (message: string) => void;
  onClose?: () => void;
  onToolOutput?: (path: string, toolName: string) => void;
  onToolsChange?: (tools: ToolDef[]) => void;
  onActiveToolChange?: (tool: ToolDef | null) => void;
  recentFiles?: string[];
  recentOutputs?: RecentOutput[];
}

export interface ToolsPanelHandle {
  loadFile: (path: string, toolKind: "invoice" | "customs" | "customs-extract" | "data") => void;
  selectTool: (id: string) => void;
}

type FileInput = Exclude<ToolDef["input"], "text">;

const INPUT_FILTERS: Record<FileInput, { name: string; extensions: string[] }[]> = {
  excel: [{ name: "Excel / CSV", extensions: ["xlsx", "xls", "csv"] }],
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

const TOOL_ORDER = ["invoice-packing", "data-analysis", "hs-code", "customs-generator", "customs-extractor"];

function workflowLabel(tool: ToolDef): string {
  if (tool.id === "invoice-packing") return "单据制作";
  if (tool.id === "data-analysis") return "数据分析";
  if (tool.id === "hs-code") return "资料查询";
  return "报关处理";
}

function inputLabel(input: ToolDef["input"]): string {
  if (input === "text") return "关键词";
  if (input === "pdf") return "PDF";
  return "Excel / CSV";
}

function outputLabel(output: ToolDef["output"]): string {
  if (output === "zip") return "ZIP 文件";
  if (output === "excel") return "Excel 文件";
  return "结构化结果";
}

function buildQueryUrl(baseUrl: string, endpoint: string, query: string): string {
  const encoded = encodeURIComponent(query.trim());
  if (endpoint.endsWith("=")) return `${baseUrl}${endpoint}${encoded}`;
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${baseUrl}${endpoint}${separator}q=${encoded}`;
}

function ToolGlyph({ id, size = 18 }: { id: string; size?: number }) {
  if (id === "invoice-packing") return <PackageCheck size={size} />;
  if (id === "data-analysis") return <BarChart3 size={size} />;
  if (id === "hs-code") return <Hash size={size} />;
  if (id === "customs-generator") return <FileSpreadsheet size={size} />;
  if (id === "customs-extractor") return <FileSearch size={size} />;
  return <Wrench size={size} />;
}

export const ToolsPanel = forwardRef<ToolsPanelHandle, ToolsPanelProps>(function ToolsPanel({
  onSendToAssistant,
  onClose,
  onToolOutput,
  onToolsChange,
  onActiveToolChange,
  recentFiles = [],
}, ref) {
  const [tools, setTools] = useState<ToolDef[]>([]);
  const [sidecarUrl, setSidecarUrl] = useState("http://127.0.0.1:8000");
  const [sidecarReady, setSidecarReady] = useState(false);
  const [sidecarError, setSidecarError] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<ToolDef | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [jsonResult, setJsonResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastReviewRef = useRef<{ key: string; time: number }>({ key: "", time: 0 });

  const visibleTools = useMemo(() => [...tools].sort((a, b) => {
    const ai = TOOL_ORDER.indexOf(a.id);
    const bi = TOOL_ORDER.indexOf(b.id);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  }), [tools]);

  const parsedResult = useMemo<Record<string, any> | null>(() => {
    if (!jsonResult) return null;
    try { return JSON.parse(jsonResult) as Record<string, any>; }
    catch { return null; }
  }, [jsonResult]);

  const compatibleRecentFiles = useMemo(() => {
    if (!activeTool || activeTool.input === "text") return [];
    const allowed = new Set(INPUT_FILTERS[activeTool.input].flatMap((filter) => filter.extensions));
    return recentFiles.filter((path) => allowed.has(path.split(".").pop()?.toLowerCase() || "")).slice(0, 4);
  }, [activeTool, recentFiles]);

  const hasInput = activeTool?.input === "text" ? query.trim().length > 0 : Boolean(filePath);
  const hasResult = Boolean(savedPath || jsonResult);

  const clearExecution = useCallback((clearInput = true) => {
    if (clearInput) {
      setFilePath(null);
      setQuery("");
    }
    setSavedPath(null);
    setJsonResult(null);
    setError(null);
  }, []);

  const selectActiveTool = useCallback((tool: ToolDef) => {
    setActiveTool(tool);
    clearExecution(true);
  }, [clearExecution]);

  const askAssistantToReview = useCallback(() => {
    if (!activeTool || !onSendToAssistant) return;
    const inputValue = activeTool.input === "text" ? query.trim() : filePath || "";
    const reviewKey = `${activeTool.id}:${inputValue}:${savedPath || jsonResult?.slice(0, 100) || ""}`;
    const now = Date.now();
    if (lastReviewRef.current.key === reviewKey && now - lastReviewRef.current.time < 10000) return;
    lastReviewRef.current = { key: reviewKey, time: now };
    const inputLine = activeTool.input === "text" ? `查询条件：${query.trim()}` : `输入文件：${filePath || "未记录"}`;
    const resultLine = savedPath ? `输出文件：${savedPath}` : `工具返回结果：\n${(jsonResult || "").slice(0, 12000)}`;
    onSendToAssistant(`我刚用「${activeTool.name}」执行了物流工具。\n${inputLine}\n${resultLine}\n请检查结果、指出风险，并给出下一步建议。`);
  }, [activeTool, filePath, jsonResult, onSendToAssistant, query, savedPath]);

  const refreshTools = useCallback(async () => {
    if (!sidecarReady) return;
    try {
      const resp = await fetch(`${sidecarUrl}/api/tools`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const nextTools = (data.tools || []) as ToolDef[];
      setTools(nextTools);
      setActiveTool((current) => current || nextTools.find((tool) => tool.id === "invoice-packing") || nextTools[0] || null);
      setError(null);
    } catch (e) {
      setError(`拉取工具列表失败：${e}`);
    }
  }, [sidecarReady, sidecarUrl]);

  const checkStatus = useCallback(async () => {
    try {
      const status = await invoke<SidecarStatus>("sidecar_status");
      setSidecarReady(status.ready);
      if (status.url) setSidecarUrl(status.url);
      setSidecarError(status.error || null);
    } catch (invokeError) {
      // 普通浏览器预览没有 Tauri invoke，开发时直接探测本地 sidecar。
      try {
        const resp = await fetch(`${sidecarUrl}/api/health`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        setSidecarReady(true);
        setSidecarError(null);
      } catch {
        setSidecarReady(false);
        setSidecarError(String(invokeError));
      }
    }
  }, [sidecarUrl]);

  useEffect(() => {
    checkStatus();
    let unlisten: UnlistenFn | undefined;
    (async () => {
      try {
        unlisten = await listen<SidecarStatus>("sidecar-status", (event) => {
          setSidecarReady(event.payload.ready);
          if (event.payload.url) setSidecarUrl(event.payload.url);
          setSidecarError(event.payload.error || null);
        });
      } catch {
        // Browser preview has no Tauri event bridge.
      }
    })();
    return () => { unlisten?.(); };
  }, [checkStatus]);

  useEffect(() => { refreshTools(); }, [refreshTools]);

  useImperativeHandle(ref, () => ({
    loadFile: (path, toolKind) => {
      const normalized = path.trim();
      if (!normalized) return;
      const targetId = toolKind === "invoice"
        ? "invoice-packing"
        : toolKind === "customs"
          ? "customs-generator"
          : toolKind === "customs-extract"
            ? "customs-extractor"
            : "data-analysis";
      const matched = tools.find((tool) => tool.id === targetId)
        || tools.find((tool) => tool.input !== "text")
        || null;
      if (matched) setActiveTool(matched);
      setFilePath(normalized);
      setQuery("");
      clearExecution(false);
    },
    selectTool: (id) => {
      const matched = tools.find((tool) => tool.id === id);
      if (matched) selectActiveTool(matched);
    },
  }), [clearExecution, selectActiveTool, tools]);

  useEffect(() => { onToolsChange?.(tools); }, [onToolsChange, tools]);
  useEffect(() => { onActiveToolChange?.(activeTool); }, [activeTool, onActiveToolChange]);

  const pickFile = useCallback(async () => {
    if (!activeTool || activeTool.input === "text") return;
    clearExecution(false);
    try {
      const selected = await openDialog({ multiple: false, filters: INPUT_FILTERS[activeTool.input] });
      if (typeof selected === "string" && selected) setFilePath(selected);
    } catch (e) {
      setError(`选文件失败：${e}`);
    }
  }, [activeTool, clearExecution]);

  const runTool = useCallback(async () => {
    if (!activeTool || !hasInput || !sidecarReady) return;
    setRunning(true);
    setError(null);
    setSavedPath(null);
    setJsonResult(null);
    try {
      if (activeTool.input === "text") {
        const resp = await fetch(buildQueryUrl(sidecarUrl, activeTool.endpoint, query));
        if (!resp.ok) {
          const body = await resp.json().catch(() => null);
          throw new Error(body?.detail || `HTTP ${resp.status}`);
        }
        setJsonResult(JSON.stringify(await resp.json(), null, 2));
        return;
      }

      const activeFilePath = filePath as string;
      let fileBlob: Blob;
      try {
        const bytes = await readFile(activeFilePath);
        fileBlob = new Blob([bytes]);
      } catch (e) {
        throw new Error(`无法读取文件 ${activeFilePath}：${e}。请确认路径正确。`);
      }

      const fileName = activeFilePath.split(/[\\/]/).pop() || "upload";
      const formData = new FormData();
      formData.append("file", new File([fileBlob], fileName), fileName);
      const resp = await fetch(`${sidecarUrl}${activeTool.endpoint}`, { method: "POST", body: formData });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(body?.detail || `HTTP ${resp.status}`);
      }

      if (activeTool.output === "json") {
        setJsonResult(JSON.stringify(await resp.json(), null, 2));
      } else {
        const resultBlob = await resp.blob();
        const extension = OUTPUT_DEFAULT_NAME[activeTool.output].split(".")[1];
        const defaultName = `${activeTool.id}-${new Date().toISOString().slice(0, 10)}.${extension}`;
        const savePath = await saveDialog({ defaultPath: defaultName, filters: OUTPUT_FILTERS[activeTool.output] });
        if (!savePath) {
          setError("已取消保存。结果尚未写入本地文件。");
          return;
        }
        const buffer = new Uint8Array(await resultBlob.arrayBuffer());
        await invoke("write_binary_file", { path: savePath, data: Array.from(buffer) });
        setSavedPath(savePath);
        onToolOutput?.(savePath, activeTool.name);
      }
    } catch (e) {
      setError(`工具执行失败：${e}`);
    } finally {
      setRunning(false);
    }
  }, [activeTool, filePath, hasInput, onToolOutput, query, sidecarReady, sidecarUrl]);

  const hsResults = activeTool?.id === "hs-code" && Array.isArray(parsedResult?.results) ? parsedResult.results : null;
  const analysisColumns = activeTool?.id === "data-analysis" && Array.isArray(parsedResult?.columns) ? parsedResult.columns : null;
  const missingColumnCount = analysisColumns?.filter((column: any) => Number(column.missing) > 0).length || 0;

  return (
    <div className="tools-panel tool-page">
      <header className="tools-page-header">
        <div>
          <span className="tools-page-eyebrow">BUSINESS AUTOMATION</span>
          <h1>物流工具</h1>
          <p>选择工具并提供输入，执行结果可以继续交给 AI 助手检查。</p>
        </div>
        <div className="tools-page-actions">
          <div className={`sidecar-status ${sidecarReady ? "ready" : "error"}`}>
            {sidecarReady ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
            {sidecarReady ? "工具服务在线" : "工具服务离线"}
          </div>
          {onClose && (
            <button className="tools-close-button" onClick={onClose} title="返回 AI 助手" aria-label="返回 AI 助手">
              <X size={18} />
            </button>
          )}
        </div>
      </header>

      {sidecarError && !sidecarReady && <div className="tools-banner error">Sidecar 未连接：{sidecarError}</div>}

      <div className="tools-body">
        <aside className="tools-list" aria-label="可用工具">
          <div className="tools-list-title">全部工具</div>
          <div className="tools-list-scroll">
            {visibleTools.length === 0 ? (
              <div className="tools-empty">
                {sidecarReady ? "没有获取到工具" : "正在等待工具服务…"}
              </div>
            ) : visibleTools.map((tool) => (
              <button
                key={tool.id}
                className={`tool-card ${activeTool?.id === tool.id ? "active" : ""}`}
                onClick={() => selectActiveTool(tool)}
              >
                <span className="tool-card-icon"><ToolGlyph id={tool.id} /></span>
                <span className="tool-card-copy">
                  <strong>{tool.name}</strong>
                  <small>{workflowLabel(tool)} · {inputLabel(tool.input)} → {outputLabel(tool.output)}</small>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
        </aside>

        <section className="tools-detail">
          {activeTool ? (
            <>
              <div className="tool-detail-top">
                <div className="tool-detail-heading">
                  <span className="tool-detail-icon"><ToolGlyph id={activeTool.id} size={20} /></span>
                  <div>
                    <h2>{activeTool.name}</h2>
                    <p>{activeTool.description}</p>
                  </div>
                </div>
                <div className="tool-detail-meta">
                  <span>{inputLabel(activeTool.input)}</span>
                  <span>{outputLabel(activeTool.output)}</span>
                </div>
              </div>

              <div className="tool-workflow" aria-label="执行步骤">
                <div className="done"><span>1</span><div><strong>选择工具</strong><small>{activeTool.name}</small></div></div>
                <div className={hasInput ? "done" : "current"}><span>2</span><div><strong>提供输入</strong><small>{activeTool.input === "text" ? "输入编码或品名" : "选择本地文件"}</small></div></div>
                <div className={hasResult ? "done" : hasInput ? "current" : ""}><span>3</span><div><strong>执行与结果</strong><small>{hasResult ? "已生成结果" : "检查后执行"}</small></div></div>
              </div>

              <div className="tool-input-section">
                <div className="tool-section-heading">
                  <div><strong>{activeTool.input === "text" ? "查询条件" : "输入文件"}</strong><small>{activeTool.input === "text" ? "支持 HS 编码或中文品名" : `支持 ${inputLabel(activeTool.input)}`}</small></div>
                  {(filePath || query) && (
                    <button className="tool-reset-button" onClick={() => clearExecution(true)} title="清除输入">
                      <RotateCcw size={14} />清除
                    </button>
                  )}
                </div>

                {activeTool.input === "text" ? (
                  <>
                    <form className="tool-query-form" onSubmit={(event) => { event.preventDefault(); runTool(); }}>
                      <Search size={18} />
                      <input value={query} onChange={(event) => { setQuery(event.target.value); clearExecution(false); }} placeholder="例如：6109100021、棉制T恤、锂离子电池" autoFocus />
                      <button type="submit" className="btn-primary" disabled={!hasInput || running || !sidecarReady}>
                        {running ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}
                        {running ? "查询中" : "查询"}
                      </button>
                    </form>
                    <div className="tool-query-examples">
                      <span>快速示例</span>
                      {["棉制T恤", "6109100021", "锂离子电池"].map((value) => (
                        <button key={value} onClick={() => { setQuery(value); clearExecution(false); }}>{value}</button>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <button className={`file-pick-zone ${filePath ? "has-file" : ""}`} onClick={pickFile}>
                      {filePath ? (
                        <>
                          <span className="file-pick-icon"><FileSpreadsheet size={21} /></span>
                          <span className="file-pick-copy"><strong>{filePath.split(/[\\/]/).pop()}</strong><small>{filePath}</small></span>
                          <span className="file-pick-change">重新选择</span>
                        </>
                      ) : (
                        <>
                          <span className="file-pick-icon"><Upload size={21} /></span>
                          <span className="file-pick-copy"><strong>选择 {inputLabel(activeTool.input)} 文件</strong><small>点击打开本地文件选择器</small></span>
                        </>
                      )}
                    </button>
                    {compatibleRecentFiles.length > 0 && (
                      <div className="tool-recent-files">
                        <span><Clock3 size={13} />最近使用</span>
                        <div>{compatibleRecentFiles.map((path) => (
                          <button key={path} onClick={() => { setFilePath(path); clearExecution(false); }} title={path}>{path.split(/[\\/]/).pop()}</button>
                        ))}</div>
                      </div>
                    )}
                    <div className="tool-actions">
                      <button className="btn-primary" onClick={runTool} disabled={!hasInput || running || !sidecarReady}>
                        {running ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
                        {running ? "执行中" : "执行工具"}
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div className="tool-result-section">
                <div className="tool-section-heading">
                  <div><strong>执行结果</strong><small>{running ? "工具正在处理" : hasResult ? "结果已就绪" : "执行后在这里查看结果"}</small></div>
                  {hasResult && onSendToAssistant && (
                    <button className="tool-ai-button" onClick={askAssistantToReview}><Sparkles size={14} />让 AI 检查</button>
                  )}
                </div>

                {running && <div className="tool-result-placeholder"><LoaderCircle className="spin" size={22} /><span>正在处理，请稍候…</span></div>}
                {!running && error && <div className="tool-error"><AlertCircle size={18} /><div><strong>执行失败</strong><pre>{error}</pre></div></div>}
                {!running && !error && !hasResult && <div className="tool-result-placeholder"><FileOutput size={22} /><span>还没有执行结果</span></div>}

                {!running && savedPath && (
                  <div className="tool-file-result">
                    <CheckCircle2 size={22} />
                    <div><strong>文件已保存</strong><small>{savedPath}</small></div>
                    <button className="btn-secondary" onClick={() => invoke("open_in_explorer", { path: savedPath })}><FolderOpen size={15} />打开位置</button>
                  </div>
                )}

                {!running && hsResults && (
                  hsResults.length === 0 ? (
                    <div className="tool-result-placeholder"><Search size={22} /><span>没有找到匹配编码，请尝试更短的编码或品名关键词。</span></div>
                  ) : (
                    <div className="hs-result-list">
                      <div className="hs-result-summary">找到 {hsResults.length} 条匹配结果</div>
                      {hsResults.map((item: any) => (
                        <div className="hs-result-row" key={`${item.code}-${item.name}`}>
                          <span className="hs-code-value">{item.code}</span>
                          <span className="hs-name"><strong>{item.name}</strong><small>{item.category}</small></span>
                          <span><small>税率</small><strong>{item.tax_rate || "-"}</strong></span>
                          <span><small>退税率</small><strong>{item.export_rebate || "-"}</strong></span>
                          <span><small>单位</small><strong>{item.unit || "-"}</strong></span>
                        </div>
                      ))}
                    </div>
                  )
                )}

                {!running && analysisColumns && parsedResult && (
                  <div className="analysis-result">
                    <div className="analysis-summary">{parsedResult.summary}</div>
                    <div className="analysis-metrics">
                      <div><strong>{parsedResult.shape?.[0] ?? 0}</strong><small>数据行</small></div>
                      <div><strong>{parsedResult.shape?.[1] ?? analysisColumns.length}</strong><small>字段数</small></div>
                      <div><strong>{missingColumnCount}</strong><small>含缺失值字段</small></div>
                      <div><strong>{parsedResult.correlations?.length || 0}</strong><small>显著相关关系</small></div>
                    </div>
                    <div className="analysis-column-list">
                      {analysisColumns.slice(0, 10).map((column: any) => (
                        <div key={column.name}>
                          <span><strong>{column.name}</strong><small>{column.kind} · {column.dtype}</small></span>
                          <span>{column.unique} 个唯一值</span>
                          <span className={column.missing ? "warning" : ""}>{column.missing ? `缺失 ${column.missing_pct}%` : "完整"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!running && jsonResult && !hsResults && !analysisColumns && <pre className="tool-result-json">{jsonResult}</pre>}
                {!running && jsonResult && (hsResults || analysisColumns) && (
                  <details className="tool-raw-result"><summary>查看原始 JSON</summary><pre>{jsonResult}</pre></details>
                )}
              </div>
            </>
          ) : (
            <div className="tools-empty">请从左侧选择一个工具</div>
          )}
        </section>
      </div>
    </div>
  );
});
