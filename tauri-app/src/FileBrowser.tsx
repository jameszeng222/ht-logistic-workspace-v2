// 文件浏览器：浏览工作目录和会话目录
// - 工作目录：当前 Pi 会话的 cwd（项目文件）
// - 会话目录：~/.pi/agent/sessions/（历史会话文件）
//
// 通过 Rust 命令 list_dir 列目录、open_file 打开、open_in_explorer 定位

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, ArrowRight, ArrowUp, Check, Folder, RotateCcw } from "lucide-react";

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

interface AgentPaths {
  home: string;
  agent: string;
  sessions: string;
  extensions: string;
  skills: string;
}

// 文件扩展名 → 类型标签（字母徽标，灰调为主，Excel 用薄荷绿强调）
// 返回 { label, kind }：label 是 2-3 字母缩写，kind 用于 CSS 着色
type FileIconInfo = { label: string; kind: "excel" | "doc" | "code" | "img" | "archive" | "data" | "text" };

const EXT_KIND: Record<string, FileIconInfo> = {
  xlsx: { label: "XLS", kind: "excel" },
  xls:  { label: "XLS", kind: "excel" },
  csv:  { label: "CSV", kind: "excel" },
  pdf:  { label: "PDF", kind: "doc" },
  doc:  { label: "DOC", kind: "doc" },
  docx: { label: "DOC", kind: "doc" },
  md:   { label: "MD",  kind: "doc" },
  txt:  { label: "TXT", kind: "text" },
  json: { label: "{}",  kind: "data" },
  jsonl:{ label: "{}",  kind: "data" },
  rs:   { label: "RS",  kind: "code" },
  ts:   { label: "TS",  kind: "code" },
  tsx:  { label: "TS",  kind: "code" },
  js:   { label: "JS",  kind: "code" },
  jsx:  { label: "JS",  kind: "code" },
  py:   { label: "PY",  kind: "code" },
  html: { label: "HTML",kind: "code" },
  css:  { label: "CSS", kind: "code" },
  zip:  { label: "ZIP", kind: "archive" },
  tar:  { label: "TAR", kind: "archive" },
  gz:   { label: "GZ",  kind: "archive" },
  png:  { label: "IMG", kind: "img" },
  jpg:  { label: "IMG", kind: "img" },
  jpeg: { label: "IMG", kind: "img" },
  gif:  { label: "IMG", kind: "img" },
  svg:  { label: "SVG", kind: "img" },
};

function getFileIcon(name: string): FileIconInfo {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return EXT_KIND[ext] || { label: "FILE", kind: "text" };
}

// 判断是否 Excel 文件（用于显示"单据"/"数据"工具按钮）
function isExcelFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ext === "xlsx" || ext === "xls";
}

function isPdfFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ext === "pdf";
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// 将路径拆分为面包屑段
function splitPath(path: string): { name: string; path: string }[] {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const result: { name: string; path: string }[] = [];
  // Windows 盘符
  const isWindows = /^[A-Za-z]:/.test(parts[0] || "");
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    if (isWindows && i === 0) {
      acc = parts[0] + "\\";
    } else {
      acc = acc ? acc + "/" + parts[i] : "/" + parts[i];
    }
    result.push({ name: parts[i], path: acc });
  }
  return result;
}

interface FileBrowserProps {
  currentCwd?: string;
  compact?: boolean;
  hideTabs?: boolean;
  selectionMode?: boolean;
  selectedFiles?: string[];
  onToggleFile?: (path: string) => void;
  /** 点击"分析"按钮时回调，把文件绝对路径交给聊天框作为附件 */
  onPickFile?: (path: string) => void;
  /** 点击"单据"/"数据"按钮时回调，把文件交给工具区执行对应工具 */
  onRunTool?: (path: string, toolKind: "invoice" | "customs" | "customs-extract" | "data") => void;
  /** 最近使用文件（localStorage 持久化），上下文区显示 */
  recentFiles?: string[];
  /** 工具输出文件（最近 3 个），上下文区显示 */
  toolOutputs?: { path: string; toolName: string; time: number }[];
}

type BrowserTab = "workspace" | "sessions";

// 右键上下文菜单项
interface CtxMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}
interface CtxMenuState {
  x: number;
  y: number;
  items: CtxMenuItem[];
}

export function FileBrowser({
  currentCwd,
  compact = false,
  hideTabs = false,
  selectionMode = false,
  selectedFiles = [],
  onToggleFile,
  onPickFile,
  onRunTool,
  recentFiles = [],
  toolOutputs = [],
}: FileBrowserProps) {
  const [tab, setTab] = useState<BrowserTab>("workspace");
  const [agentPaths, setAgentPaths] = useState<AgentPaths | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<DirEntry | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  // 右键上下文菜单：在文件行 / 上下文区条目上 right-click 触发
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);
  const openCtxMenu = useCallback((e: React.MouseEvent, items: CtxMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    if (items.length === 0) return;
    // 边界处理：避免菜单超出视窗
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - items.length * 32 - 16);
    setCtxMenu({ x, y, items });
  }, []);

  // 菜单打开时：点击外部 / Esc / 滚动 / 窗口尺寸变化 都关闭
  useEffect(() => {
    if (!ctxMenu) return;
    const onDocClick = () => closeCtxMenu();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeCtxMenu(); };
    const onScroll = () => closeCtxMenu();
    const onResize = () => closeCtxMenu();
    // 用 mousedown 而非 click，避免点菜单项时先触发外部关闭
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [ctxMenu, closeCtxMenu]);

  // 构建文件右键菜单项：打开/定位 + (Excel) 单据制作/数据分析 + 分析
  // 注意：handleOpenFile / handleShowInExplorer 在下方定义，这里只引用不调用，
  // useCallback 的 deps 在渲染时求值，必须等它们定义之后才能放进 deps，
  // 所以这两个 builder 放到 handleShowInExplorer 之后定义（见下）。

  // 加载 agent 路径
  useEffect(() => {
    (async () => {
      try {
        const paths = await invoke<AgentPaths>("get_agent_paths");
        setAgentPaths(paths);
      } catch (e) {
        setError(`获取路径信息失败：${e}`);
      }
    })();
  }, []);

  // 切换 tab 时设置初始路径
  useEffect(() => {
    if (!agentPaths) return;
    let target: string;
    if (tab === "workspace") {
      target = currentCwd || agentPaths.home;
    } else {
      target = agentPaths.sessions;
    }
    navigateTo(target, true);
  }, [tab, agentPaths, currentCwd]);

  const navigateTo = useCallback(async (path: string, reset: boolean = false) => {
    setLoading(true);
    setError(null);
    setSelectedEntry(null);
    try {
      const list = await invoke<DirEntry[]>("list_dir", { path });
      setEntries(list);
      setCurrentPath(path);
      if (reset) {
        setHistory([path]);
        setHistoryIdx(0);
      } else {
        // 截断历史（如果在中间后退过）
        const newHistory = history.slice(0, historyIdx + 1);
        newHistory.push(path);
        setHistory(newHistory);
        setHistoryIdx(newHistory.length - 1);
      }
    } catch (e) {
      setError(String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [history, historyIdx]);

  const goBack = useCallback(() => {
    if (historyIdx <= 0) return;
    const newIdx = historyIdx - 1;
    setHistoryIdx(newIdx);
    const path = history[newIdx];
    setLoading(true);
    invoke<DirEntry[]>("list_dir", { path })
      .then((list) => { setEntries(list); setCurrentPath(path); setError(null); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [history, historyIdx]);

  const goForward = useCallback(() => {
    if (historyIdx >= history.length - 1) return;
    const newIdx = historyIdx + 1;
    setHistoryIdx(newIdx);
    const path = history[newIdx];
    setLoading(true);
    invoke<DirEntry[]>("list_dir", { path })
      .then((list) => { setEntries(list); setCurrentPath(path); setError(null); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [history, historyIdx]);

  const goUp = useCallback(() => {
    if (!currentPath) return;
    const parts = currentPath.split(/[\\/]/);
    if (parts.length <= 1) return;
    // Windows 盘符根目录
    if (parts.length === 2 && /^[A-Za-z]:$/.test(parts[0])) {
      navigateTo(parts[0] + "\\");
      return;
    }
    parts.pop();
    const parent = parts.join("/") || "/";
    navigateTo(parent);
  }, [currentPath, navigateTo]);

  const handleEntryClick = useCallback((entry: DirEntry) => {
    setSelectedEntry(entry);
    if (entry.is_dir) {
      navigateTo(entry.path);
    }
  }, [navigateTo]);

  const handleOpenFile = useCallback(async (entry: DirEntry) => {
    try {
      await invoke("open_file", { path: entry.path });
    } catch (e) {
      setError(`打开文件失败：${e}`);
    }
  }, []);

  const handleShowInExplorer = useCallback(async (entry: DirEntry) => {
    try {
      await invoke("open_in_explorer", { path: entry.path });
    } catch (e) {
      setError(`定位失败：${e}`);
    }
  }, []);

  const handlePathSubmit = useCallback(() => {
    const input = pathInputRef.current;
    if (!input) return;
    const path = input.value.trim();
    if (path && path !== currentPath) {
      navigateTo(path);
    }
  }, [currentPath, navigateTo]);

  // 构建文件右键菜单项：打开/定位 + (Excel) 单据制作/数据分析 + 加入分析
  const buildFileMenuItems = useCallback((entry: DirEntry): CtxMenuItem[] => {
    const items: CtxMenuItem[] = [];
    if (!entry.is_dir) {
      items.push({ label: "打开", onClick: () => handleOpenFile(entry) });
    }
    items.push({ label: "在文件管理器中定位", onClick: () => handleShowInExplorer(entry) });
    if (!entry.is_dir) {
      if (onPickFile) {
        items.push({ label: "加入聊天分析", onClick: () => onPickFile(entry.path) });
      }
      if (onRunTool && isExcelFile(entry.name)) {
        items.push({ label: "单据制作", onClick: () => onRunTool(entry.path, "invoice") });
        items.push({ label: "报关单生成", onClick: () => onRunTool(entry.path, "customs") });
        items.push({ label: "数据分析", onClick: () => onRunTool(entry.path, "data") });
      }
      if (onRunTool && isPdfFile(entry.name)) {
        items.push({ label: "报关单提取", onClick: () => onRunTool(entry.path, "customs-extract") });
      }
    }
    return items;
  }, [onPickFile, onRunTool, handleOpenFile, handleShowInExplorer]);

  // 构建路径右键菜单项（用于"最近使用 / 工具输出"区，只有路径没有 DirEntry）
  const buildPathMenuItems = useCallback((path: string): CtxMenuItem[] => {
    const name = path.split(/[\\/]/).pop() || path;
    const items: CtxMenuItem[] = [];
    if (onPickFile) items.push({ label: "加入聊天分析", onClick: () => onPickFile(path) });
    if (onRunTool && isExcelFile(name)) {
      items.push({ label: "单据制作", onClick: () => onRunTool(path, "invoice") });
      items.push({ label: "报关单生成", onClick: () => onRunTool(path, "customs") });
      items.push({ label: "数据分析", onClick: () => onRunTool(path, "data") });
    }
    if (onRunTool && isPdfFile(name)) {
      items.push({ label: "报关单提取", onClick: () => onRunTool(path, "customs-extract") });
    }
    return items;
  }, [onPickFile, onRunTool]);

  const breadcrumbs = currentPath ? splitPath(currentPath) : [];

  return (
    <div className={`file-browser ${compact ? "compact" : ""} ${selectionMode ? "selection-mode" : ""}`}>
      {/* 上下文区：最近使用 + 工具输出（在文件浏览之上，体现"工作台上下文"）
          仅展示文件名 + 图标；所有动作（分析/单据/数据）走右键菜单，避免按钮拥挤 */}
      {(recentFiles.length > 0 || toolOutputs.length > 0) && (
        <div className="fb-context">
          {recentFiles.length > 0 && (
            <div className="fb-context-group">
              <div className="fb-context-title">最近使用</div>
              {recentFiles.slice(0, 3).map((p, i) => {
                const name = p.split(/[\\/]/).pop() || p;
                return (
                  <div
                    key={`r${i}`}
                    className="fb-context-item"
                    title={`${p}（右键更多操作）`}
                    onContextMenu={(e) => openCtxMenu(e, buildPathMenuItems(p))}
                  >
                    {(() => { const ic = getFileIcon(name); return <span className={`fb-icon-badge ${ic.kind}`}>{ic.label}</span>; })()}
                    <span className="fb-context-name">{name}</span>
                  </div>
                );
              })}
            </div>
          )}
          {toolOutputs.length > 0 && (
            <div className="fb-context-group">
              <div className="fb-context-title">工具输出</div>
              {toolOutputs.map((o, i) => {
                const name = o.path.split(/[\\/]/).pop() || o.path;
                return (
                  <div
                    key={`t${i}`}
                    className="fb-context-item"
                    title={`${o.toolName} → ${o.path}（右键加入分析）`}
                    onContextMenu={(e) => openCtxMenu(e, buildPathMenuItems(o.path))}
                  >
                    {(() => { const ic = getFileIcon(name); return <span className={`fb-icon-badge ${ic.kind}`}>{ic.label}</span>; })()}
                    <span className="fb-context-name">{name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {/* 标签页切换 */}
      {!hideTabs && <div className="fb-tabs">
        <button
          className={`fb-tab ${tab === "workspace" ? "active" : ""}`}
          onClick={() => setTab("workspace")}
        >工作目录</button>
        <button
          className={`fb-tab ${tab === "sessions" ? "active" : ""}`}
          onClick={() => setTab("sessions")}
        >会话目录</button>
      </div>}

      {/* 工具栏：后退/前进/上级 + 地址栏 */}
      <div className="fb-toolbar">
        <div className="fb-nav-btns">
          <button
            className="fb-nav-btn"
            onClick={goBack}
            disabled={historyIdx <= 0}
            title="后退"
            aria-label="后退"
          ><ArrowLeft size={14} /></button>
          <button
            className="fb-nav-btn"
            onClick={goForward}
            disabled={historyIdx >= history.length - 1}
            title="前进"
            aria-label="前进"
          ><ArrowRight size={14} /></button>
          <button
            className="fb-nav-btn"
            onClick={goUp}
            disabled={!currentPath}
            title="上一级"
            aria-label="上一级"
          ><ArrowUp size={14} /></button>
          <button
            className="fb-nav-btn"
            onClick={() => navigateTo(currentPath, true)}
            disabled={loading}
            title="刷新"
            aria-label="刷新"
          ><RotateCcw size={14} /></button>
        </div>
        <div className="fb-path-field">
          <Folder size={13} aria-hidden="true" />
          <input
            ref={pathInputRef}
            className="fb-path-input"
            defaultValue={currentPath}
            key={currentPath}
            onKeyDown={(e) => { if (e.key === "Enter") handlePathSubmit(); }}
            placeholder="输入路径..."
            aria-label="当前文件路径"
          />
        </div>
      </div>

      {/* 面包屑 */}
      {breadcrumbs.length > 0 && (
        <div className="fb-breadcrumbs">
          {compact ? (
            // compact 模式只显示最后一段目录名（缩写）
            <button
              className="fb-crumb"
              onClick={() => navigateTo(currentPath)}
              title={currentPath}
            >{breadcrumbs[breadcrumbs.length - 1].name}</button>
          ) : (
            breadcrumbs.map((crumb, i) => (
              <span key={i} className="fb-crumb-wrap">
                {i > 0 && <span className="fb-crumb-sep">/</span>}
                <button
                  className="fb-crumb"
                  onClick={() => navigateTo(crumb.path)}
                >{crumb.name}</button>
              </span>
            ))
          )}
        </div>
      )}

      {/* 文件列表 */}
      <div className="fb-file-list">
        {loading ? (
          <div className="fb-empty">加载中…</div>
        ) : error ? (
          <div className="fb-error">
            <div className="fb-error-msg">❌ {error}</div>
            <button className="btn-secondary" onClick={goUp}>返回上级</button>
          </div>
        ) : entries.length === 0 ? (
          <div className="fb-empty">空目录</div>
        ) : (
          <>
            {/* 表头（非 compact 模式才显示）*/}
            {!compact && <div className="fb-list-header">
              <span className="fb-col-name">名称</span>
              <span className="fb-col-size">大小</span>
              <span className="fb-col-modified">修改时间</span>
              <span className="fb-col-actions">操作</span>
            </div>}
            {/* 条目 */}
            {entries.map((entry) => (
              <div
                key={entry.path}
                className={`fb-entry ${entry.is_dir ? "dir" : "file"} ${(selectionMode ? selectedFiles.includes(entry.path) : selectedEntry?.path === entry.path) ? "selected" : ""}`}
                onClick={() => {
                  if (entry.is_dir) {
                    handleEntryClick(entry);
                    return;
                  }
                  setSelectedEntry(entry);
                  if (selectionMode && onToggleFile) onToggleFile(entry.path);
                }}
                onDoubleClick={() => { if (!selectionMode && !entry.is_dir && onPickFile) onPickFile(entry.path); }}
                onContextMenu={(e) => openCtxMenu(e, buildFileMenuItems(entry))}
                draggable={!entry.is_dir}
                onDragStart={(e) => {
                  if (entry.is_dir) return;
                  // 用 text/plain 传递绝对路径，聊天区 drop 时读取并插入输入框
                  e.dataTransfer.setData("text/plain", entry.path);
                  e.dataTransfer.setData("application/x-file-path", entry.path);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                title={!entry.is_dir ? `${entry.name}（双击分析 · 右键更多操作）` : entry.name}
              >
                <span className="fb-col-name">
                  {entry.is_dir ? (
                    <span className="fb-icon-badge dir">DIR</span>
                  ) : (() => { const ic = getFileIcon(entry.name); return <span className={`fb-icon-badge ${ic.kind}`}>{ic.label}</span>; })()}
                  <span className="fb-entry-name">{entry.name}</span>
                </span>
                {!compact && <span className="fb-col-size">{formatSize(entry.size)}</span>}
                {!compact && <span className="fb-col-modified">{formatDate(entry.modified)}</span>}
                {/* 行内只保留"打开/定位"两个常用动作；"单据/数据/分析"改右键菜单 */}
                {selectionMode && !entry.is_dir ? (
                  <span className={`fb-selection-toggle ${selectedFiles.includes(entry.path) ? "active" : ""}`} aria-hidden="true">
                    {selectedFiles.includes(entry.path) && <Check size={13} strokeWidth={2.5} />}
                  </span>
                ) : (
                  <span className="fb-col-actions" onClick={(e) => e.stopPropagation()}>
                    {!entry.is_dir && (
                      <button
                        className="fb-action-btn"
                        onClick={() => handleOpenFile(entry)}
                        title="用系统默认程序打开"
                      >打开</button>
                    )}
                    <button
                      className="fb-action-btn"
                      onClick={() => handleShowInExplorer(entry)}
                      title="在文件管理器中显示"
                    >定位</button>
                  </span>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      {/* 状态栏 */}
      <div className="fb-statusbar">
        <span>{entries.length} 项</span>
        {entries.filter((e) => !e.is_dir).length > 0 && (
          <span>· {entries.filter((e) => !e.is_dir).length} 个文件</span>
        )}
        {entries.filter((e) => e.is_dir).length > 0 && (
          <span>· {entries.filter((e) => e.is_dir).length} 个文件夹</span>
        )}
        {selectionMode && selectedFiles.length > 0 ? (
          <span className="fb-status-selected">· 已选 {selectedFiles.length} 个文件</span>
        ) : selectedEntry && (
          <span className="fb-status-selected">· 已选：{selectedEntry.name}</span>
        )}
      </div>

      {/* 右键上下文菜单（Portal 到 body，脱离父容器裁切）*/}
      {ctxMenu && createPortal(
        <div
          className="fb-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {ctxMenu.items.map((item, i) => (
            <button
              key={i}
              className={`fb-ctx-menu-item ${item.danger ? "danger" : ""}`}
              disabled={item.disabled}
              onClick={() => { item.onClick(); closeCtxMenu(); }}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
