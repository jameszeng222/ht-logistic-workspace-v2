// 完整版 Pi Assistant GUI
// 7 大能力：会话管理 / 模型切换 / 设置 / 主题 / 上下文用量 / 状态刷新 / 斜杠命令
//
// Bug 修复：
// 1. 文字 double —— 不用 StrictMode + listener ref 保证只注册一次
// 2. 会话无法新增 —— new_session RPC + scan_sessions 扫描历史
// 3. 输入框无法发送 —— StrictMode 副作用消除

import { useEffect, useState, useCallback, useRef, useMemo, type DragEvent as ReactDragEvent } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { PiEvent } from "./pi-client";
import { Markdown } from "./Markdown";
import { CommandPalette } from "./CommandPalette";
import { ExtensionManager } from "./ExtensionManager";
import { extractAssistantMessageContent, formatPiError, rebuildTurnsFromMessages, isTutorialWelcome } from "./utils";
import { ChartView, extractChartConfig } from "./Chart";
import { ToolsPanel, type ToolsPanelHandle, type ToolDef } from "./ToolsPanel";
import { FileBrowser } from "./FileBrowser";
import { LogisticsDataPanel } from "./LogisticsDataPanel";
import { checkUpdate, downloadAndInstallUpdate, type UpdateStatus } from "./updater";
import type { ToolCall, AssistantMsg, Turn } from "./types";
import {
  ArrowUp,
  Bot,
  Box,
  ChartNoAxesCombined,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FileCheck2,
  FileOutput,
  Files,
  ExternalLink,
  FolderInput,
  FolderOpen,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Moon,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Settings,
  Sheet,
  Sparkles,
  Sun,
  Trash2,
  Wrench,
} from "lucide-react";
import pilotAvatar from "./assets/pilot-avatar.png";
import "./styles.css";

// ============ 类型 ============
interface Toast { id: number; msg: string; type: "info"|"error"|"success"; }
interface SessionInfo { path: string; name: string; mtime: number; size: number; title?: string; cwd?: string; }
interface ModelInfo { id: string; name: string; provider: string; contextWindow?: number; reasoning?: boolean; }
interface PiState { model: ModelInfo | null; thinkingLevel: string; isStreaming: boolean; sessionFile?: string; sessionName?: string; messageCount: number; }
interface SessionStats { contextUsage?: { percent: number; tokens: number; contextWindow: number }; cost?: number; }
interface JsonModel { id: string; name: string; }
interface JsonProvider { baseUrl: string; api: string; apiKey: string; models: JsonModel[]; }
interface ModelsConfig { providers: Record<string, JsonProvider>; }
type QuickActionKind = "prompt" | "files" | "tools";
type QuickActionIcon = "document" | "chart" | "mail" | "sparkles" | "folder" | "tool";
interface QuickAction {
  id: string;
  title: string;
  description: string;
  kind: QuickActionKind;
  prompt: string;
  requiresFiles: boolean;
  icon: QuickActionIcon;
}

interface ToolOutput {
  path: string;
  toolName: string;
  time: number;
}

const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  {
    id: "interpret-files",
    title: "解读所选文件",
    description: "总结关键单证信息与风险",
    kind: "prompt",
    prompt: "请解读所选项目文件，总结关键单证信息、异常风险和下一步建议。",
    requiresFiles: true,
    icon: "document",
  },
  {
    id: "summarize-data",
    title: "总结项目数据",
    description: "提取指标、差异与异常",
    kind: "prompt",
    prompt: "请汇总所选项目文件中的数据，列出关键指标、差异、异常和可执行结论。",
    requiresFiles: true,
    icon: "chart",
  },
  {
    id: "draft-email",
    title: "起草客户邮件",
    description: "基于项目资料生成邮件",
    kind: "prompt",
    prompt: "请根据所选项目文件起草一封专业的客户邮件，说明当前情况、关键数据和需要客户确认的事项。",
    requiresFiles: true,
    icon: "mail",
  },
  {
    id: "open-tools",
    title: "继续调用业务工具",
    description: "进入物流工具执行任务",
    kind: "tools",
    prompt: "",
    requiresFiles: false,
    icon: "tool",
  },
];

function loadQuickActions(): QuickAction[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("ht-quick-actions") || "null");
    if (!Array.isArray(parsed)) return DEFAULT_QUICK_ACTIONS;
    const validIcons: QuickActionIcon[] = ["document", "chart", "mail", "sparkles", "folder", "tool"];
    const actions = parsed
      .filter((item) => Boolean(
        item && typeof item.id === "string" && typeof item.title === "string"
        && typeof item.description === "string" && ["prompt", "files", "tools"].includes(item.kind)
      ))
      .map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        kind: item.kind as QuickActionKind,
        prompt: typeof item.prompt === "string" ? item.prompt : "",
        requiresFiles: Boolean(item.requiresFiles),
        icon: validIcons.includes(item.icon) ? item.icon : "sparkles",
      } satisfies QuickAction));
    return actions.length > 0 ? actions : DEFAULT_QUICK_ACTIONS;
  } catch {
    return DEFAULT_QUICK_ACTIONS;
  }
}

function QuickActionGlyph({ icon, size = 17 }: { icon: QuickActionIcon; size?: number }) {
  if (icon === "document") return <FileCheck2 size={size} />;
  if (icon === "chart") return <ChartNoAxesCombined size={size} />;
  if (icon === "mail") return <Mail size={size} />;
  if (icon === "folder") return <FolderOpen size={size} />;
  if (icon === "tool") return <Wrench size={size} />;
  return <Sparkles size={size} />;
}

function formatSessionTime(timestamp: number) {
  const value = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function loadSessionMetadata(key: string) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function naturalProjectName(session: SessionInfo) {
  const cwd = session.cwd?.trim().replace(/[\\/]+$/, "") || "";
  return cwd ? (cwd.split(/[\\/]/).pop() || cwd) : "Logistic Workspace";
}

let toastId = 0;

// ============ 主题 Hook ============
function useTheme() {
  const [theme, setTheme] = useState<"dark"|"light"|"system">(() => {
    return (localStorage.getItem("pi-theme") as any) || "light";
  });
  useEffect(() => {
    const resolved = theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : theme;
    document.documentElement.setAttribute("data-theme", resolved);
    localStorage.setItem("pi-theme", theme);
  }, [theme]);
  // 跟随系统变化
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      document.documentElement.setAttribute("data-theme", mq.matches ? "dark" : "light");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);
  return { theme, setTheme };
}

// ============ 主应用 ============
export default function App() {
  const { theme, setTheme } = useTheme();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // 会话管理
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSessionPath, setCurrentSessionPath] = useState<string | null>(null);
  // 预览模式：浏览历史会话不切换 Pi 活动会话，不打断当前输出。
  // previewPath !== currentSessionPath 时表示正在预览某个历史会话。
  // 发送新消息时若处于预览，先 switch_session 真正切换再发送。
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const previewPathRef = useRef<string | null>(null);
  previewPathRef.current = previewPath;

  // 模型
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [currentModel, setCurrentModel] = useState<ModelInfo | null>(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showPermissionDropdown, setShowPermissionDropdown] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<"assistant" | "tool" | "data">("assistant");
  const [assistantSidebarView, setAssistantSidebarView] = useState<"quick" | "files">("quick");
  const [contextPanelTab, setContextPanelTab] = useState<"files" | "outputs">("files");
  const [quickActions, setQuickActions] = useState<QuickAction[]>(loadQuickActions);
  const [editingQuickAction, setEditingQuickAction] = useState<QuickAction | null>(null);
  // 下拉框定位：用 fixed + Portal 渲染到 body，彻底脱离所有父容器 overflow 裁切
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const railModelBtnRef = useRef<HTMLButtonElement>(null);
  const permBtnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  // 仅做定位与开关状态切换；模型列表刷新在按钮 onClick 中单独调用，避免依赖 refreshModels。
  const openDropdown = useCallback((btn: HTMLButtonElement | null, which: "model" | "perm") => {
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setDropdownPos({ left: rect.left, bottom: window.innerHeight - rect.top + 4, width: Math.max(rect.width, 260) });
    if (which === "model") { setShowModelDropdown(true); setShowPermissionDropdown(false); }
    else { setShowPermissionDropdown(true); setShowModelDropdown(false); }
  }, []);
  // 拖拽文件到聊天框：高亮提示 + drop 时把文件绝对路径插入输入框
  const [dragOver, setDragOver] = useState(false);
  // 附件：选中的文件绝对路径列表，发送时拼到消息里
  const [attachments, setAttachments] = useState<string[]>([]);

  // 状态 & 统计
  const [piState, setPiState] = useState<PiState | null>(null);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<string>("medium");

  // 设置面板
  const [showSettings, setShowSettings] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ kind: "idle" });
  const [appVersion, setAppVersion] = useState<string>("");
  const [autoCompaction, setAutoCompaction] = useState(true);
  const [autoRetry, setAutoRetry] = useState(true);
  const [envKeys, setEnvKeys] = useState<{provider: string; env: string; configured: boolean}[]>([]);
  // 权限模式：cautious（审慎）/ workspace（工作台）/ trust（全信任）
  // - cautious:   所有 confirm 都弹窗（生成文件前确认，删除/外部请求必须确认）
  // - workspace:  只对"删除"等关键字弹窗，其余自动放行
  // - trust:      所有 confirm 自动放行
  const [permissionMode, setPermissionMode] = useState<"cautious" | "workspace" | "trust">(() => {
    const saved = localStorage.getItem("pi-permission-mode");
    if (saved === "workspace" || saved === "trust" || saved === "cautious") return saved;
    // 兼容旧 autoConfirm=true → trust；默认工作台模式（推荐，弹窗最少且安全）
    return localStorage.getItem("pi-auto-confirm") === "true" ? "trust" : "workspace";
  });
  const permissionModeLabel = permissionMode === "cautious" ? "审慎模式" : permissionMode === "workspace" ? "工作台模式" : "全信任模式";
  // 工作目录：用户设定的默认工作目录，启动时传给 pi 子进程作为 cwd。
  // 空=不设定（沿用 Tauri 进程 cwd）。持久化在 localStorage(key: pi-workdir)。
  // 切换工作目录会重启 pi 进程；新建会话的 --cwd-- 目录编码也基于此路径，
  // 这样"输入和输出的文件都在工作目录"自然成立，文件浏览器也会默认定位到这里。
  const [workdir, setWorkdir] = useState<string>(() => localStorage.getItem("pi-workdir") || "");
  const workdirRef = useRef(workdir);
  workdirRef.current = workdir;
  const [showExtManager, setShowExtManager] = useState(false);
  // 会话分组折叠状态（key=项目名，value=是否展开）
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("pi-collapsed-projects") || "[]")); }
    catch { return new Set(); }
  });

  // 模型配置
  const [modelsConfig, setModelsConfig] = useState<ModelsConfig | null>(null);
  const [modelsConfigDirty, setModelsConfigDirty] = useState(false);
  const [modelsConfigSaving, setModelsConfigSaving] = useState(false);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  // 测试连接状态：key = providerId, value = { status: 'testing'|'ok'|'fail', message, model }
  const [connTest, setConnTest] = useState<Record<string, { status: "testing" | "ok" | "fail"; message?: string; model?: string }>>({});

  // 系统提示词编辑器（读写 ~/.pi/agent/SYSTEM.md）
  const [systemPrompt, setSystemPrompt] = useState("");
  const [systemPromptPath, setSystemPromptPath] = useState("SYSTEM.md");
  const [systemPromptDirty, setSystemPromptDirty] = useState(false);
  const [systemPromptSaving, setSystemPromptSaving] = useState(false);
  const systemPromptPathHint = "~/.pi/agent/SYSTEM.md（替换默认系统提示词） / APPEND_SYSTEM.md（追加到默认提示词）";

  // 日志查看器（Track 5 观测调试）
  const [showLogViewer, setShowLogViewer] = useState(false);
  const [logs, setLogs] = useState<{ type: "stderr" | "event"; text: string; time: number }[]>([]);
  const [logFilter, setLogFilter] = useState<"all" | "stderr" | "event">("all");
  const [logSearch, setLogSearch] = useState("");
  const logListRef = useRef<HTMLDivElement>(null);
  const logAutoFollow = useRef(true);
  const addLog = useCallback((type: "stderr" | "event", text: string) => {
    setLogs((prev) => {
      const next = [...prev, { type, text, time: Date.now() }];
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
  }, []);

  // 斜杠命令面板
  const [showCmdPalette, setShowCmdPalette] = useState(false);
  const [cmdIndex, setCmdIndex] = useState(0);

  // 会话管理补全：搜索 / 重命名
  const [sessionSearch, setSessionSearch] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [sessionMenuPath, setSessionMenuPath] = useState<string | null>(null);
  const [movingSessionPath, setMovingSessionPath] = useState<string | null>(null);
  const [moveProjectInput, setMoveProjectInput] = useState("");
  const [sessionTitleOverrides, setSessionTitleOverrides] = useState<Record<string, string>>(() => loadSessionMetadata("ht-session-titles"));
  const [sessionProjectOverrides, setSessionProjectOverrides] = useState<Record<string, string>>(() => loadSessionMetadata("ht-session-projects"));

  // 引用
  const messagesRef = useRef<HTMLDivElement>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // 会话切换中的 loading 状态：重建历史 + Markdown 渲染较重，先显示 loading 再加载
  const [switching, setSwitching] = useState(false);
  const currentTurnId = useRef<string | null>(null);
  const currentMsgId = useRef<string | null>(null);
  // 跟踪 Pi 当前 sessionFile 的最新值，供 scan_sessions 作为权威路径提示反推会话根目录。
  const sessionFileRef = useRef<string | undefined>(undefined);
  const pendingNewSessionRef = useRef(false);

  // 流式节流
  const pendingTextRef = useRef<Map<string, string>>(new Map());
  const pendingThinkingRef = useRef<Map<string, string>>(new Map());
  const rafRef = useRef<number | null>(null);

  const toast = useCallback((msg: string, type: Toast["type"] = "info") => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  // ====== RPC 请求封装 ======
  const rpc = useCallback(async (command: any) => {
    return invoke<any>("send_request", { command });
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const data = await rpc({ type: "get_state" });
      const state = data as PiState;
      setPiState(state);
      setCurrentModel(state.model);
      setThinkingLevel(state.thinkingLevel);
      if (state.sessionFile) {
        sessionFileRef.current = state.sessionFile;
        setCurrentSessionPath(state.sessionFile);
      }
    } catch (e) { /* 静默 */ }
  }, [rpc]);

  const refreshStats = useCallback(async () => {
    try {
      const data = await rpc({ type: "get_session_stats" });
      setSessionStats(data as SessionStats);
    } catch (e) { /* 静默 */ }
  }, [rpc]);

  const refreshModels = useCallback(async () => {
    try {
      const data = await rpc({ type: "get_available_models" });
      setModels((data?.models || []) as ModelInfo[]);
    } catch (e) { /* 静默 */ }
  }, [rpc]);

  // 跟踪 Pi 当前 sessionFile 的最新值，供 scan_sessions 作为权威路径提示反推会话根目录。
  // 用 ref 避免 refreshSessions 依赖 piState 导致频繁重建。
  const refreshSessions = useCallback(async () => {
    try {
      // 传入 Pi 自己的当前会话路径，Rust 端据此反推真实会话根目录扫描，
      // 避免因 Pi 实际存储路径与硬编码 ~/.pi/agent/sessions 不一致而扫空、清空侧边栏。
      const list = await invoke<SessionInfo[]>("scan_sessions", {
        sessionFileHint: sessionFileRef.current ?? null,
      });
      setSessions(list);
    } catch (e) {
      // 不再静默吞掉：扫不到历史会话正是"新建会话后旧会话消失"的根因，必须可见。
      toast(`扫描历史会话失败: ${e}`, "error");
    }
  }, [toast]);

  const refreshEnvKeys = useCallback(async () => {
    try {
      const list = await invoke<{provider: string; env: string; configured: boolean}[]>("check_env_keys");
      setEnvKeys(list);
    } catch { /* 静默 */ }
  }, []);

  // 模型配置加载/保存/应用（直接读写 Pi 原生 ~/.pi/agent/models.json）
  const loadModelsConfig = useCallback(async () => {
    try {
      const data = await invoke<any>("get_models_config");
      setModelsConfig(data as ModelsConfig);
      setModelsConfigDirty(false);
    } catch (e) {
      toast(`加载模型配置失败: ${e}`, "error");
    }
  }, [toast]);

  const saveModelsConfig = useCallback(async () => {
    if (!modelsConfig) return;
    setModelsConfigSaving(true);
    try {
      await invoke("save_models_config", { config: modelsConfig });
      const result = await invoke<string>("apply_models_config");
      await invoke("restart_pi", { cwd: workdirRef.current.trim() || null, sessionPath: null });
      await refreshModels();
      await refreshState();
      setModelsConfigDirty(false);
      toast(`模型配置已保存。${result}`, "success");
    } catch (e) {
      toast(`保存失败: ${e}`, "error");
    } finally {
      setModelsConfigSaving(false);
    }
  }, [modelsConfig, toast, refreshModels, refreshState]);

  const updateProvider = useCallback((providerId: string, updates: Partial<JsonProvider>) => {
    setModelsConfig(prev => {
      if (!prev) return prev;
      const existing = prev.providers[providerId] || { baseUrl: "", api: "openai-completions", apiKey: "", models: [] };
      return {
        ...prev,
        providers: { ...prev.providers, [providerId]: { ...existing, ...updates } }
      };
    });
    setModelsConfigDirty(true);
  }, []);

  // ====== 历史恢复：get_messages → 重建 turns ======
  const loadHistory = useCallback(async () => {
    try {
      const data = await rpc({ type: "get_messages" });
      const msgs = data?.messages || [];
      if (msgs.length === 0) { setTurns([]); return; }
      const rebuilt = rebuildTurnsFromMessages(msgs);
      setTurns(rebuilt);
      setAutoFollow(true);
    } catch { /* 静默 */ }
  }, [rpc]);

  // ====== 系统提示词编辑器：加载/保存 ======
  const loadSystemPrompt = useCallback(async (filename: string) => {
    try {
      const content = await invoke<string>("read_text_file", { path: filename });
      setSystemPrompt(content);
      setSystemPromptDirty(false);
    } catch (e) {
      // 文件不存在时返回错误，给空内容让用户新建
      setSystemPrompt("");
      setSystemPromptDirty(false);
      toast(`未读取到 ${filename}（可新建）：${e}`, "info");
    }
  }, [toast]);
  const saveSystemPrompt = useCallback(async () => {
    setSystemPromptSaving(true);
    try {
      await invoke("write_text_file", { path: systemPromptPath, content: systemPrompt });
      setSystemPromptDirty(false);
      // SYSTEM.md / APPEND_SYSTEM.md 是 Pi 子进程启动时一次性读取的，运行中不会热重载。
      // 这里重启 Pi 子进程（保留当前 cwd）让新提示词真正生效。
      try {
        await invoke("restart_pi", { cwd: workdirRef.current.trim() || null, sessionPath: null });
        setReady(true);
        await refreshState();
        toast("系统提示词已保存并重新加载（Pi 已重启）。", "success");
      } catch (e) {
        toast(`提示词已写入文件，但重启 Pi 失败：${e}。请手动重启应用。`, "error");
      }
    } catch (e) {
      toast(`保存失败: ${e}`, "error");
    } finally {
      setSystemPromptSaving(false);
    }
  }, [systemPrompt, systemPromptPath, toast, refreshState]);

  // ====== 流式节流 ======
  const applyPendingDeltas = useCallback((turnList: Turn[]) => {
    const textUpdates = new Map(pendingTextRef.current);
    const thinkUpdates = new Map(pendingThinkingRef.current);
    pendingTextRef.current.clear();
    pendingThinkingRef.current.clear();
    if (textUpdates.size === 0 && thinkUpdates.size === 0) return turnList;
    return turnList.map((turn) => ({
      ...turn,
      assistantMsgs: turn.assistantMsgs.map((message) => ({
        ...message,
        text: message.text + (textUpdates.get(message.id) || ""),
        thinking: (message.thinking || "") + (thinkUpdates.get(message.id) || "") || undefined,
      })),
    }));
  }, []);

  const flushText = useCallback(() => {
    rafRef.current = null;
    setTurns((prev) => applyPendingDeltas(prev));
  }, [applyPendingDeltas]);

  const appendText = useCallback((msgId: string, delta: string) => {
    pendingTextRef.current.set(msgId, (pendingTextRef.current.get(msgId) || "") + delta);
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushText);
  }, [flushText]);

  const appendThinking = useCallback((msgId: string, delta: string) => {
    pendingThinkingRef.current.set(msgId, (pendingThinkingRef.current.get(msgId) || "") + delta);
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushText);
  }, [flushText]);

  const finishAssistantMessage = useCallback((message: any, explicitError?: string) => {
    const turnId = currentTurnId.current;
    if (!turnId) return;
    const activeMsgId = currentMsgId.current;
    const msgId = message?.id || activeMsgId || "msg-" + Date.now();
    const finalContent = extractAssistantMessageContent(message);
    const rawError = explicitError || finalContent.error || (message?.stopReason === "error" ? "回答意外中断，请重试。" : "");
    const displayError = rawError ? formatPiError(rawError) : undefined;

    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setTurns((prev) => applyPendingDeltas(prev).map((turn) => {
      if (turn.id !== turnId) return turn;
      let found = false;
      const assistantMsgs = turn.assistantMsgs.map((item) => {
        if (item.id !== msgId && item.id !== activeMsgId) return item;
        found = true;
        return {
          ...item,
          text: finalContent.text || item.text,
          thinking: finalContent.thinking || item.thinking,
          error: displayError,
          streaming: false,
        };
      });
      if (!found) {
        assistantMsgs.push({
          id: msgId,
          text: finalContent.text,
          thinking: finalContent.thinking || undefined,
          error: displayError,
          streaming: false,
          toolCallIds: [],
        });
      }
      return { ...turn, assistantMsgs, status: displayError ? "done" : turn.status };
    }));
    currentMsgId.current = null;

    if (displayError) {
      setBusy(false);
      currentTurnId.current = null;
      toast(displayError, "error");
      refreshState();
      refreshStats();
      refreshSessions();
      addLog("event", "assistant_error · " + rawError);
    }
  }, [addLog, applyPendingDeltas, refreshSessions, refreshState, refreshStats, toast]);

  // ====== 自动命名会话 ======
  // Pi 默认会话显示名是"首条用户消息"。但若用户没主动 set_session_name，
  // 侧边栏列表只能从 .jsonl 文件解析首条 user 文本作标题。
  // 在 agent_end 后，若会话尚无 sessionName，取首条 user 消息文本调
  // set_session_name 让 Pi 持久化，使侧边栏标题即时更新且跨重启稳定。
  // 这只是把"首条消息"正式登记为会话名，不消耗额外 LLM 调用。
  const autoNameSession = useCallback(async () => {
    try {
      // 已有 sessionName 则不覆盖（用户手动命名优先）
      if (piState?.sessionName) return;
      // 取首条 user 消息文本（turns[0].userMessage）
      const firstUser = turns[0]?.userMessage?.trim();
      if (!firstUser) return;
      // 截断到 40 字符（与 scan_sessions 标题逻辑一致）
      const title = firstUser.length > 40 ? firstUser.slice(0, 40) + "…" : firstUser;
      await rpc({ type: "set_session_name", name: title } as any);
    } catch { /* 静默：命名失败不影响主流程 */ }
  }, [piState?.sessionName, turns, rpc]);

  // ====== 事件处理 ======
  const handleEvent = useCallback((ev: PiEvent) => {
    switch (ev.type) {
      case "agent_start":
        setBusy(true);
        // 预览模式下若当前活动会话开始新输出，自动退出预览回到实时视图。
        // 否则流式事件会覆盖预览的 turns，且用户看不到新输出。
        if (previewPathRef.current && previewPathRef.current !== sessionFileRef.current) {
          setPreviewPath(null);
          loadHistoryRef.current();
        }
        addLog("event", "agent_start · 开始推理");
        break;
      case "agent_end":
        setBusy(false);
        setTurns((prev) => {
          const flushed = applyPendingDeltas(prev);
          // 先把所有 streaming 标记为 done
          let next = flushed.map((t) => t.status === "streaming"
            ? { ...t, status: "done" as const, assistantMsgs: t.assistantMsgs.map((message) => ({ ...message, streaming: false })) }
            : t);
          // 过滤 Pi 输出的教程欢迎语（命中教程签名即过滤，不要求 userMessage 为空，
          // 因为 Pi 会把教程当首条消息的回复输出）。
          next = next.filter((t) => {
            const assistantText = t.assistantMsgs.map((m) => m.text).join("");
            return !isTutorialWelcome(t.userMessage, assistantText);
          });
          return next;
        });
        if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        currentTurnId.current = null; currentMsgId.current = null;
        // agent_end 后刷新状态 & 统计 & 自动命名 & 刷新会话列表
        refreshState(); refreshStats();
        autoNameSession();
        refreshSessions();
        addLog("event", "agent_end · 推理结束");
        break;
      case "message_start": {
        const msg = (ev as any).message;
        if (msg?.role !== "assistant") break;
        const msgId = msg.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        currentMsgId.current = msgId;
        setTurns((prev) => prev.map((t) =>
          t.id === currentTurnId.current
            ? { ...t, assistantMsgs: [...t.assistantMsgs, { id: msgId, text: "", streaming: true, toolCallIds: [] }] }
            : t
        ));
        break;
      }
      case "message_update": {
        const d = (ev as any).assistantMessageEvent;
        if (d?.type === "text_delta" && typeof d.delta === "string") {
          if (currentMsgId.current) appendText(currentMsgId.current, d.delta);
        } else if (d?.type === "thinking_delta" && typeof d.delta === "string") {
          if (currentMsgId.current) appendThinking(currentMsgId.current, d.delta);
        } else if (d?.type === "error") {
          finishAssistantMessage(d.error, d.error?.errorMessage || d.reason);
        }
        break;
      }
      case "message_end": {
        const message = (ev as any).message;
        if (message?.role === "assistant") finishAssistantMessage(message);
        break;
      }
      case "tool_execution_start":
        const tc: ToolCall = { id: ev.toolCallId, name: ev.toolName, args: ev.args, status: "running" };
        setTurns((prev) => prev.map((t) =>
          t.id === currentTurnId.current
            ? { ...t, toolCalls: { ...t.toolCalls, [tc.id]: tc },
                assistantMsgs: t.assistantMsgs.map((m, i) =>
                  i === t.assistantMsgs.length - 1 ? { ...m, toolCallIds: [...m.toolCallIds, tc.id] } : m) }
            : t
        ));
        addLog("event", `tool_start · ${ev.toolName}`);
        break;
      case "tool_execution_end":
        setTurns((prev) => prev.map((t) =>
          t.toolCalls[ev.toolCallId]
            ? { ...t, toolCalls: { ...t.toolCalls, [ev.toolCallId]: { ...t.toolCalls[ev.toolCallId], result: ev.result, status: ev.isError ? "error" : "done" } } }
            : t
        ));
        addLog("event", `tool_end · ${ev.toolCallId.slice(0, 8)} ${ev.isError ? "❌" : "✓"}`);
        break;
      case "extension_ui_request":
        handleUiRequest(ev as any);
        addLog("event", `ui_request · ${(ev as any).method} · ${(ev as any).title || ""} · ${(ev as any).message || ""}`);
        break;
      case "compaction_end":
        refreshState(); refreshStats();
        addLog("event", "compaction_end · 上下文已压缩");
        break;
      case "pi_process_exit":
        setReady(false); setBusy(false);
        if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        setTurns((prev) => applyPendingDeltas(prev).map((turn) => turn.status === "streaming"
          ? {
              ...turn,
              status: "done" as const,
              assistantMsgs: turn.assistantMsgs.map((message, index, list) => ({
                ...message,
                streaming: false,
                error: index === list.length - 1 ? "Pi 服务意外退出，请重新发送这条消息。" : message.error,
              })),
            }
          : turn));
        currentTurnId.current = null;
        currentMsgId.current = null;
        toast("Pi 进程退出", "error");
        addLog("event", "pi_process_exit · 进程退出");
        break;
      default:
        // 捕获未知事件类型（如 Pi 内置的 permission_request 等），记录日志便于排查
        addLog("event", `unknown · ${(ev as any).type} · ${JSON.stringify(ev).slice(0, 200)}`);
        break;
    }
  }, [appendText, appendThinking, applyPendingDeltas, finishAssistantMessage, toast, refreshState, refreshStats, addLog, autoNameSession, refreshSessions]);

  // ====== Extension UI Modal ======
  const [uiRequest, setUiRequest] = useState<any>(null);
  const handleUiRequest = useCallback((ev: any) => {
    const fireAndForget = ["notify","setStatus","setWidget","setTitle","setWorkingMessage","setWorkingVisible","setWorkingIndicator","setFooter","setTheme","setEditorText","setEditorComponent","pasteToEditor","setToolsExpanded"];
    if (fireAndForget.includes(ev.method)) return;
    // 权限模式处理 confirm / select 类型请求
    // Pi 工具权限弹窗：method="select", title="Permission Required",
    //   message="Current agent requested tool 'find' for path '...' outside working directory..."
    //   options=["Allow","Deny"] 或类似
    // Pi 扩展确认弹窗：method="confirm", title=自定义, message=自定义
    if (ev.method === "confirm" || ev.method === "select") {
      const mode = localStorage.getItem("pi-permission-mode") || "workspace";
      const text = `${ev.title || ""} ${ev.message || ""}`;
      const lower = text.toLowerCase();

      // ===== tool-name 白名单分级（替代纯关键字猜测）=====
      // Pi 权限弹窗 message 通常含 "tool 'xxx'" 或 "tool \"xxx\""，正则提取 tool name
      const toolNameMatch = text.match(/tool\s+['"]([a-zA-Z0-9_\-]+)['"]/);
      const toolName = toolNameMatch ? toolNameMatch[1].toLowerCase() : "";

      // 安全只读工具白名单：自动放行，任何模式下都不弹窗
      const SAFE_TOOLS = new Set([
        "read", "read_file", "readfile", "cat", "head", "tail", "more", "less",
        "ls", "list", "list_dir", "listdir", "dir", "tree",
        "glob", "find", "ffind", "ffls", "ffgrep", "ffcat", "ffread",
        "grep", "rg", "search", "ffsearch",
        "stat", "view", "show", "check", "info",
        "kb_search", "chart_render",
      ]);
      // 写入/修改类工具：始终弹窗（即便 workspace 模式也不自动放行）
      const WRITE_TOOLS = new Set([
        "write", "write_file", "writefile", "edit", "edit_file", "patch", "apply_patch",
        "mkdir", "mkdirs", "rm", "remove", "delete", "del", "rmdir", "unlink",
        "mv", "move", "rename", "copy", "cp",
        "bash", "sh", "shell", "exec", "execute", "run", "run_script", "python", "node", "powershell", "cmd",
        "http_request", "http", "fetch", "curl", "wget",
        "query_database", "insert", "update", "drop", "truncate",
      ]);
      // 本地物流工具白名单：自动放行（调用本地 sidecar，可控）
      const LOGISTIC_TOOL_PREFIX = "logistic_";

      const isLogistic = toolName.startsWith(LOGISTIC_TOOL_PREFIX);
      const isSafe = SAFE_TOOLS.has(toolName);
      const isWrite = WRITE_TOOLS.has(toolName);

      // 兜底：破坏性操作关键字（tool name 未识别时用）
      const destructiveKeywords = ["删除", "移除", "清空", "卸载", "格式化", "覆盖", "delete", "remove", "rm ", "drop ", "truncate", "uninstall", "overwrite", "rmdir", "del "];
      const isDestructive = destructiveKeywords.some((k) => lower.includes(k));

      // HTTP 非 GET 判断（tool='http_request' 且 message 含 POST/PUT/DELETE 等）
      const httpMethodMatch = text.match(/method\s*[:=]\s*['"]?(GET|POST|PUT|DELETE|PATCH)['"]?/i);
      const isHttpNonGet = toolName === "http_request" || toolName === "http" || toolName === "fetch" || toolName === "curl";
      const isHttpDestructive = isHttpNonGet && httpMethodMatch && httpMethodMatch[1].toUpperCase() !== "GET";

      // 分级结论
      // safeTool: 只读工具或物流白名单 → 自动放行（任何模式）
      // needsConfirm: 写入工具 / 破坏性关键字 / HTTP 非 GET → 弹窗
      // unknown: tool name 未识别，按模式策略决定
      const isAutoApprove = isSafe || isLogistic;
      const isNeedsConfirm = isWrite || isDestructive || isHttpDestructive;

      addLog("event", `${ev.method}_recv · mode=${mode} · tool=${toolName || "?"} · safe=${isSafe} · write=${isWrite} · logistic=${isLogistic} · destructive=${isDestructive} · httpNonGet=${isHttpDestructive} · title="${ev.title || ""}" · msg="${(ev.message || "").slice(0, 80)}"`);
      const autoApprove = (reason: string) => {
        // select 类型回复 {value: 选项}；confirm 类型回复 {confirmed:true}
        // Pi 权限弹窗的 options 通常是 ["Allow","Deny"] 或 ["允许","拒绝"]，取第一个 Allow 类选项
        let payload: any;
        if (ev.method === "select") {
          const opts: string[] = ev.options || [];
          // 优先选 "Allow"/"允许"/"Yes"/"是"，否则取第一个非 Deny 项
          const allowIdx = opts.findIndex((o) => /^(allow|允许|yes|是|ok|确定)$/i.test(o.trim()));
          const denyIdx = opts.findIndex((o) => /^(deny|拒绝|no|否|cancel|取消)$/i.test(o.trim()));
          const idx = allowIdx >= 0 ? allowIdx : (denyIdx >= 0 ? (denyIdx === 0 ? 1 : 0) : 0);
          payload = { value: opts[idx] || "Allow", cancelled: false };
        } else {
          payload = { confirmed: true, cancelled: false };
        }
        invoke("send_command", { command: { type: "extension_ui_response", id: ev.id, ...payload } })
          .catch((e) => addLog("event", `auto-approve 失败: ${e}`));
        addLog("event", `auto-approve · ${mode} · ${reason} · ${ev.title || ""} · ${(ev.message || "").slice(0, 60)}`);
      };
      if (mode === "trust") {
        // 全信任：所有 confirm/select 自动放行
        autoApprove("全信任");
        return;
      }
      // safe tool / logistic 白名单：任何非 trust 模式下也自动放行（只读安全）
      if (isAutoApprove && !isNeedsConfirm) {
        autoApprove(isSafe ? `只读工具(${toolName})` : `物流工具(${toolName})`);
        return;
      }
      // 明确需要确认的（写/破坏/HTTP非GET）：workspace 和 cautious 都弹窗
      if (isNeedsConfirm) {
        setUiRequest({ ev, inputValue: "", selectIndex: 0 });
        return;
      }
      // workspace 模式下未识别 tool name：默认放行（保持原体验），但记录日志便于排查
      if (mode === "workspace") {
        autoApprove("工作台未识别tool默认放行");
        return;
      }
      // cautious 模式下未识别 tool name：弹窗（保守）
      // setUiRequest 在下方统一处理
    }
    setUiRequest({ ev, inputValue: "", selectIndex: 0 });
  }, [addLog]);
  const respondUiRequest = useCallback((payload: any) => {
    if (!uiRequest) return;
    const finalPayload = { type: "extension_ui_response", id: uiRequest.ev.id, ...payload };
    setUiRequest(null);
    invoke("send_command", { command: finalPayload }).catch((e) => toast(`UI 响应失败: ${e}`, "error"));
  }, [uiRequest, toast]);

  // ====== 初始化：注册 listener + 启动 pi ======
  // 只在挂载时执行一次（空依赖数组）。handler 用 ref 持有最新引用，
  // 避免 handler 重建触发 effect 重跑 → 重复 start_pi → 死循环。
  // 之前的 bug：依赖数组含 handleEvent（它依赖 autoNameSession→turns），
  // 每次 turns 变化 handleEvent 重建 → init effect 重跑 → start_pi 再调 → 循环。
  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;
  const addLogRef = useRef(addLog);
  addLogRef.current = addLog;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const refreshStateRef = useRef(refreshState); refreshStateRef.current = refreshState;
  const refreshModelsRef = useRef(refreshModels); refreshModelsRef.current = refreshModels;
  const refreshSessionsRef = useRef(refreshSessions); refreshSessionsRef.current = refreshSessions;
  const refreshEnvKeysRef = useRef(refreshEnvKeys); refreshEnvKeysRef.current = refreshEnvKeys;
  const loadHistoryRef = useRef(loadHistory); loadHistoryRef.current = loadHistory;
  const loadModelsConfigRef = useRef(loadModelsConfig); loadModelsConfigRef.current = loadModelsConfig;
  // 读取当前 app 版本号（供设置页"关于与更新"显示）
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion("unknown"));
  }, []);
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    let unlistenStderr: UnlistenFn | undefined;
    (async () => {
      try {
        const fn1 = await listen<PiEvent>("pi-event", (e) => handleEventRef.current(e.payload));
        const fn2 = await listen<{ line: string }>("pi-stderr", (e) => addLogRef.current("stderr", e.payload.line));
        if (cancelled) { fn1(); fn2(); return; }
        unlisten = fn1; unlistenStderr = fn2;
        addLogRef.current("event", "app_init · 正在启动 Pi 进程…");
        // 启动时若已设定工作目录，通过 restart_pi 传 cwd 给 pi 子进程，
        // 使 pi 在该目录下读写文件、新建会话也基于此 cwd 编码目录名。
        // restart_pi 内部会先 stop（空操作）再 spawn，等价于带 cwd 的 start_pi。
        const initCwd = workdirRef.current.trim() || null;
        await invoke("restart_pi", { cwd: initCwd, sessionPath: null });
        if (cancelled) return;
        setReady(true);
        toastRef.current("已连接 Pi", "success");
        addLogRef.current("event", "app_init · Pi 已连接");
        refreshStateRef.current(); refreshModelsRef.current(); refreshSessionsRef.current(); refreshEnvKeysRef.current();
        loadHistoryRef.current();
        loadModelsConfigRef.current();
      } catch (e) {
        if (!cancelled) {
          toastRef.current(`启动失败: ${e}`, "error");
          addLogRef.current("event", `app_init · 启动失败: ${e}`);
        }
      }
    })();
    return () => { cancelled = true; unlisten?.(); unlistenStderr?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动滚动
  const handleScroll = useCallback(() => {
    const el = messagesRef.current; if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAutoFollow(atBottom); setShowScrollBtn(!atBottom && turns.length > 0);
  }, [turns.length]);
  const scrollToBottom = useCallback((smooth = true) => {
    const el = messagesRef.current; if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setAutoFollow(true); setShowScrollBtn(false);
  }, []);
  useEffect(() => { if (autoFollow) scrollToBottom(true); }, [turns, autoFollow, scrollToBottom]);

  // 日志查看器自动滚到底部
  useEffect(() => {
    if (!showLogViewer) return;
    const el = logListRef.current; if (!el) return;
    if (logAutoFollow.current) el.scrollTop = el.scrollHeight;
  }, [logs.length, showLogViewer]);

  // 全局 ESC：关闭命令面板 / 模型下拉 / 权限下拉（即使焦点不在 textarea 上也能生效）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showCmdPalette) { e.preventDefault(); setShowCmdPalette(false); return; }
      if (showModelDropdown) { e.preventDefault(); setShowModelDropdown(false); return; }
      if (showPermissionDropdown) { e.preventDefault(); setShowPermissionDropdown(false); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showCmdPalette, showModelDropdown, showPermissionDropdown]);

  // ====== 会话操作 ======
  const newSession = useCallback(() => {
    if (busy) { toast("请等待当前任务完成", "info"); return; }
    pendingNewSessionRef.current = true;
    setTurns([]); currentTurnId.current = null; currentMsgId.current = null;
    pendingTextRef.current.clear(); pendingThinkingRef.current.clear();
    setInput("");
    setAttachments([]);
    setCurrentSessionPath(null);
    setAutoFollow(true);
    setPreviewPath(null);
    setAssistantSidebarView("quick");
  }, [busy, toast]);

  const switchSession = useCallback(async (path: string) => {
    // 预览模式：不调 switch_session RPC，直接读会话文件历史显示。
    // 这样不打断当前会话的 agent 输出（Pi 单进程单活动会话，
    // switch_session 会切走活动会话导致原会话输出丢失）。
    // 真正的 switch_session 推迟到用户发新消息时（见 send）。
    //
    // 性能：会话历史重建 + 全量 Markdown 渲染是同步重活，直接 setTurns
    // 会阻塞主线程导致点击后卡顿。先清空 turns 并显示 loading，让浏览器
    // 渲染一帧，再异步读取+重建，UI 立即响应。
    pendingNewSessionRef.current = false;
    setTurns([]);
    setSwitching(true);
    try {
      // 让 loading 先渲染一帧
      await new Promise((r) => requestAnimationFrame(r));
      const data = await invoke<{ messages: any[] }>("read_session_history", { path });
      const msgs = data?.messages || [];
      const rebuilt = rebuildTurnsFromMessages(msgs);
      setTurns(rebuilt);
      currentTurnId.current = null; currentMsgId.current = null;
      pendingTextRef.current.clear(); pendingThinkingRef.current.clear();
      setAutoFollow(true);
      setPreviewPath(path);
    } catch (e) {
      toast(`读取会话历史失败: ${e}`, "error");
    } finally {
      setSwitching(false);
    }
  }, [toast]);

  const deleteSession = useCallback(async (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("确定删除这个会话？")) return;
    try {
      await invoke("delete_session", { path });
      setSessionTitleOverrides((previous) => {
        const next = { ...previous };
        delete next[path];
        localStorage.setItem("ht-session-titles", JSON.stringify(next));
        return next;
      });
      setSessionProjectOverrides((previous) => {
        const next = { ...previous };
        delete next[path];
        localStorage.setItem("ht-session-projects", JSON.stringify(next));
        return next;
      });
      if (previewPath === path) { setPreviewPath(null); setTurns([]); }
      setSessionMenuPath(null);
      await refreshSessions();
      toast("已删除", "success");
    } catch (err) { toast(`删除失败: ${err}`, "error"); }
  }, [previewPath, refreshSessions, toast]);

  const startRename = useCallback((session?: SessionInfo) => {
    const path = session?.path || currentSessionPath;
    if (!path) return;
    setRenameInput(session ? (sessionTitleOverrides[path] || session.title || session.name || "") : (piState?.sessionName || ""));
    setRenamingPath(path);
    setSessionMenuPath(null);
  }, [currentSessionPath, piState, sessionTitleOverrides]);

  const confirmRename = useCallback(async () => {
    if (!renamingPath) return;
    const path = renamingPath;
    const name = renameInput.trim();
    if (!name) { setRenamingPath(null); return; }
    setRenamingPath(null);
    try {
      setSessionTitleOverrides((previous) => {
        const next = { ...previous, [path]: name };
        localStorage.setItem("ht-session-titles", JSON.stringify(next));
        return next;
      });
      setSessions((previous) => previous.map((session) => session.path === path ? { ...session, title: name } : session));
      if (path === currentSessionPath) {
        try {
          await rpc({ type: "set_session_name", name });
          await refreshState();
        } catch {
          // 本地标题已经保存；Pi 恢复连接后仍可正常继续会话。
        }
      }
      toast("已重命名", "success");
    } catch (e) { toast(`重命名失败: ${e}`, "error"); }
  }, [currentSessionPath, renamingPath, renameInput, rpc, refreshState, toast]);

  const startMoveSession = useCallback((session: SessionInfo) => {
    setMovingSessionPath(session.path);
    setMoveProjectInput(sessionProjectOverrides[session.path] || naturalProjectName(session));
    setSessionMenuPath(null);
  }, [sessionProjectOverrides]);

  const confirmMoveSession = useCallback(() => {
    if (!movingSessionPath) return;
    const project = moveProjectInput.trim();
    if (!project) { setMovingSessionPath(null); return; }
    setSessionProjectOverrides((previous) => {
      const next = { ...previous, [movingSessionPath]: project };
      localStorage.setItem("ht-session-projects", JSON.stringify(next));
      return next;
    });
    setMovingSessionPath(null);
    setAssistantSidebarView("quick");
    toast(`已移动到项目：${project}`, "success");
  }, [moveProjectInput, movingSessionPath, toast]);

  // clone 当前会话
  const cloneSession = useCallback(async () => {
    if (busy) { toast("请等待当前任务完成", "info"); return; }
    try {
      const data = await rpc({ type: "clone" });
      if (data?.cancelled) { toast("clone 被取消", "info"); }
      else { toast("已克隆会话", "success"); }
      await refreshState(); await refreshSessions();
    } catch (e) { toast(`克隆失败: ${e}`, "error"); }
  }, [busy, rpc, toast, refreshState, refreshSessions]);

  // ====== 模型切换 ======
  const setModel = useCallback(async (provider: string, modelId: string) => {
    try {
      await rpc({ type: "set_model", provider, modelId });
      await refreshState();
      toast("已切换模型", "success");
    } catch (e) { toast(`切换失败: ${e}`, "error"); }
  }, [rpc, refreshState, toast]);

  // ====== 设置操作 ======

  // —— 自动更新：手动检查 + 下载安装 ——
  const doCheckUpdate = useCallback(async () => {
    setUpdateStatus({ kind: "checking" });
    try {
      const update = await checkUpdate();
      if (update?.available) {
        setUpdateStatus({
          kind: "available",
          currentVersion: update.currentVersion,
          version: update.version,
          notes: update.body || "(无更新说明)",
        });
      } else {
        setUpdateStatus({
          kind: "up-to-date",
          currentVersion: update?.currentVersion ?? appVersion,
        });
      }
    } catch (e) {
      setUpdateStatus({ kind: "error", message: String(e) });
    }
  }, [appVersion]);

  const doDownloadAndInstall = useCallback(async () => {
    setUpdateStatus({ kind: "downloading", percent: 0 });
    try {
      await downloadAndInstallUpdate((percent) => {
        setUpdateStatus({ kind: "downloading", percent });
      });
      setUpdateStatus({ kind: "done" });
      // relaunch 由 downloadAndInstallUpdate 内部调用，到这里说明重启未生效或失败
    } catch (e) {
      setUpdateStatus({ kind: "error", message: String(e) });
    }
  }, []);

  const setThinking = useCallback(async (level: string) => {
    try {
      await rpc({ type: "set_thinking_level", level });
      setThinkingLevel(level);
    } catch (e) { toast(`设置失败: ${e}`, "error"); }
  }, [rpc, toast]);

  const toggleAutoCompaction = useCallback(async (on: boolean) => {
    setAutoCompaction(on);
    try { await rpc({ type: "set_auto_compaction", enabled: on }); } catch {}
  }, [rpc]);

  const toggleAutoRetry = useCallback(async (on: boolean) => {
    setAutoRetry(on);
    try { await rpc({ type: "set_auto_retry", enabled: on }); } catch {}
  }, [rpc]);

  const setPermissionModePersist = useCallback((mode: "cautious" | "workspace" | "trust") => {
    setPermissionMode(mode);
    localStorage.setItem("pi-permission-mode", mode);
  }, []);

  // 切换项目分组折叠
  const toggleProjectCollapse = useCallback((projectName: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectName)) next.delete(projectName);
      else next.add(projectName);
      localStorage.setItem("pi-collapsed-projects", JSON.stringify([...next]));
      return next;
    });
  }, []);

  const compactNow = useCallback(async () => {
    try {
      await rpc({ type: "compact" });
      toast("已压缩会话", "success");
      await refreshState(); await refreshStats();
    } catch (e) { toast(`压缩失败: ${e}`, "error"); }
  }, [rpc, toast, refreshState, refreshStats]);

  // ====== 发送 ======
  const abort = useCallback(async () => {
    try { await invoke("send_command", { command: { type: "abort" } }); }
    catch (e) { toast(`中断失败: ${e}`, "error"); }
  }, [toast]);

  // ====== 拖拽文件到聊天框 ======
  // 从右侧文件浏览器拖入文件时，把绝对路径作为附件添加
  const handleFileDrop = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    // 优先读自定义类型，回退到 text/plain
    const path = e.dataTransfer.getData("application/x-file-path") || e.dataTransfer.getData("text/plain");
    if (!path || !path.trim()) return;
    const trimmed = path.trim();
    const fileName = trimmed.split(/[\\/]/).pop() || trimmed;
    setAttachments((prev) => prev.includes(trimmed) ? prev : [...prev, trimmed]);
    toast(`已添加附件：${fileName}`, "success");
  }, [toast]);

  // ====== 附件选择（Tauri 原生对话框） ======
  const pickAttachments = useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: true,
        filters: [
          { name: "文档", extensions: ["xlsx", "xls", "csv", "doc", "docx", "pdf", "txt", "md", "json", "png", "jpg", "jpeg"] },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      setAttachments((prev) => {
        const next = [...prev];
        for (const p of paths) { if (!next.includes(p)) next.push(p); }
        return next;
      });
      toast(`已添加 ${paths.length} 个附件`, "success");
    } catch (e) {
      toast(`选择文件失败：${e}`, "error");
    }
  }, [toast]);

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  }, []);

  // ====== 最近使用文件 + 工具输出（右侧文件栏上下文区）======
  // recentFiles: 用户最近分析/执行工具的文件，localStorage 持久化，最多 5 个
  // toolOutputs: 工具执行后保存的输出文件，localStorage 持久化，最近 10 个
  const [recentFiles, setRecentFiles] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("pi-recent-files") || "[]"); }
    catch { return []; }
  });
  const [toolOutputs, setToolOutputs] = useState<ToolOutput[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("pi-tool-outputs") || "[]");
      if (!Array.isArray(stored)) return [];
      return stored
        .filter((item): item is ToolOutput => (
          typeof item?.path === "string"
          && typeof item?.toolName === "string"
          && typeof item?.time === "number"
        ))
        .sort((a, b) => b.time - a.time)
        .slice(0, 10);
    } catch {
      return [];
    }
  });
  const addRecentFile = useCallback((path: string) => {
    setRecentFiles((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, 5);
      localStorage.setItem("pi-recent-files", JSON.stringify(next));
      return next;
    });
  }, []);
  const addToolOutput = useCallback((path: string, toolName: string) => {
    setToolOutputs((prev) => {
      const next = [
        { path, toolName, time: Date.now() },
        ...prev.filter((item) => item.path !== path),
      ].slice(0, 10);
      try { localStorage.setItem("pi-tool-outputs", JSON.stringify(next)); }
      catch { /* 保留本次运行内的记录。 */ }
      return next;
    });
  }, []);

  // ====== 从文件浏览器一键加入聊天分析 ======
  // 把文件加到附件列表，并填入默认分析 prompt（仅在输入框为空时填入，避免覆盖正在编辑的内容）
  const pickFileFromBrowser = useCallback((path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    const fileName = trimmed.split(/[\\/]/).pop() || trimmed;
    setAttachments((prev) => prev.includes(trimmed) ? prev : [...prev, trimmed]);
    // 仅在输入框为空时填入默认 prompt，避免覆盖用户正在编辑的内容
    setInput((prev) => prev.trim() ? prev : `请分析附件文件 ${fileName}，输出关键内容、异常点和下一步建议。`);
    addRecentFile(trimmed);
    setWorkspaceView("assistant");
    toast(`已加入附件：${fileName}（可直接发送）`, "success");
  }, [toast, addRecentFile]);

  const openToolOutput = useCallback(async (output: ToolOutput) => {
    try {
      await invoke("open_file", { path: output.path });
    } catch (error) {
      toast(`打开文件失败：${error}`, "error");
    }
  }, [toast]);

  const locateToolOutput = useCallback(async (output: ToolOutput) => {
    try {
      await invoke("open_in_explorer", { path: output.path });
    } catch (error) {
      toast(`定位文件失败：${error}`, "error");
    }
  }, [toast]);

  const addToolOutputToChat = useCallback((output: ToolOutput) => {
    const trimmed = output.path.trim();
    if (!trimmed) return;
    const fileName = trimmed.split(/[\\/]/).pop() || trimmed;
    setAttachments((prev) => prev.includes(trimmed) ? prev : [...prev, trimmed]);
    setInput((prev) => prev.trim()
      ? prev
      : `请检查「${output.toolName}」生成的附件 ${fileName}，确认结果是否完整、准确，并给出下一步建议。`);
    addRecentFile(trimmed);
    setAssistantSidebarView("quick");
    setWorkspaceView("assistant");
    toast(`已放入聊天框：${fileName}`, "success");
  }, [addRecentFile, toast]);

  const toggleProjectFile = useCallback((path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    const fileName = trimmed.split(/[\\/]/).pop() || trimmed;
    const selected = attachments.includes(trimmed);
    setAttachments((previous) => selected
      ? previous.filter((item) => item !== trimmed)
      : [...previous, trimmed]);
    if (selected) {
      toast(`已取消选择：${fileName}`, "info");
      return;
    }
    addRecentFile(trimmed);
    setInput((previous) => previous.trim() ? previous : "请解读所选项目文件，总结关键信息、异常风险和下一步建议。");
    toast(`已加入本次任务：${fileName}`, "success");
  }, [addRecentFile, attachments, toast]);

  const prepareFileTask = useCallback((prompt: string) => {
    if (attachments.length === 0) {
      setAssistantSidebarView("files");
      toast("请先从项目文件中选择本次任务要使用的文件", "info");
      return;
    }
    setInput(prompt);
  }, [attachments.length, toast]);

  const persistQuickActions = useCallback((next: QuickAction[]) => {
    setQuickActions(next);
    localStorage.setItem("ht-quick-actions", JSON.stringify(next));
  }, []);

  const runQuickAction = useCallback((action: QuickAction) => {
    if (action.kind === "tools") {
      setWorkspaceView("tool");
      setContextPanelTab("files");
      return;
    }
    if (action.kind === "files") {
      setWorkspaceView("assistant");
      setAssistantSidebarView("files");
      return;
    }
    setWorkspaceView("assistant");
    setAssistantSidebarView("quick");
    if (action.requiresFiles) prepareFileTask(action.prompt);
    else setInput(action.prompt);
  }, [prepareFileTask]);

  const createQuickAction = useCallback(() => {
    setEditingQuickAction({
      id: `custom-${Date.now()}`,
      title: "新快捷操作",
      description: "填写这个操作的用途",
      kind: "prompt",
      prompt: "",
      requiresFiles: false,
      icon: "sparkles",
    });
  }, []);

  const saveQuickAction = useCallback(() => {
    if (!editingQuickAction) return;
    const normalized = {
      ...editingQuickAction,
      title: editingQuickAction.title.trim(),
      description: editingQuickAction.description.trim(),
      prompt: editingQuickAction.prompt.trim(),
    };
    if (!normalized.title) { toast("请填写快捷操作名称", "info"); return; }
    if (normalized.kind === "prompt" && !normalized.prompt) { toast("请填写要使用的提示词", "info"); return; }
    const exists = quickActions.some((action) => action.id === normalized.id);
    persistQuickActions(exists
      ? quickActions.map((action) => action.id === normalized.id ? normalized : action)
      : [...quickActions, normalized]);
    setEditingQuickAction(null);
    toast(exists ? "快捷操作已更新" : "快捷操作已添加", "success");
  }, [editingQuickAction, persistQuickActions, quickActions, toast]);

  const deleteQuickAction = useCallback(() => {
    if (!editingQuickAction || !quickActions.some((action) => action.id === editingQuickAction.id)) return;
    if (!confirm(`删除快捷操作“${editingQuickAction.title}”？`)) return;
    persistQuickActions(quickActions.filter((action) => action.id !== editingQuickAction.id));
    setEditingQuickAction(null);
    toast("快捷操作已删除", "success");
  }, [editingQuickAction, persistQuickActions, quickActions, toast]);

  // ====== 从文件浏览器一键执行工具 ======
  // 点击"单据"/"数据"按钮：通过 toolsPanelRef 命令式调用 loadFile，
  // 直接操作 ToolsPanel 内部 state，无 state 同步问题，连续点击独立可靠。
  const toolsPanelRef = useRef<ToolsPanelHandle>(null);
  // 工具导航镜像状态：ToolsPanel 上报 tools/activeTool，供左侧栏渲染导航
  const [toolsList, setToolsList] = useState<ToolDef[]>([]);
  const [activeToolMirrored, setActiveToolMirrored] = useState<ToolDef | null>(null);
  const runToolFromBrowser = useCallback((path: string, toolKind: "invoice" | "customs" | "customs-extract" | "data") => {
    const trimmed = path.trim();
    if (!trimmed) return;
    const fileName = trimmed.split(/[\\/]/).pop() || trimmed;
    toolsPanelRef.current?.loadFile(trimmed, toolKind);
    setWorkspaceView("tool");
    setContextPanelTab("files");
    addRecentFile(trimmed);
    const label = toolKind === "invoice" ? "单据制作"
      : toolKind === "customs" ? "报关单生成"
      : toolKind === "customs-extract" ? "报关单提取"
      : "数据分析";
    toast(`已加载到工具区：${fileName}（${label}）`, "success");
  }, [toast, addRecentFile]);

  // ====== 工作目录设定 ======
  // 持久化到 localStorage；applyWorkdir 会重启 pi 进程使新 cwd 生效。
  const setWorkdirPersist = useCallback((dir: string) => {
    const trimmed = dir.trim();
    setWorkdir(trimmed);
    localStorage.setItem("pi-workdir", trimmed);
  }, []);
  const applyWorkdir = useCallback(async (dir: string) => {
    // 去掉末尾路径分隔符，避免 split(/[\\/]/).pop() 返回空字符串
    const trimmed = dir.trim().replace(/[\\/]+$/, "");
    if (busy) { toast("请等待当前任务完成再切换工作目录", "info"); return; }
    // 前端预校验：路径不存在直接报错，不重启 pi（后端 restart_pi 也会校验，双重保险）
    if (trimmed) {
      try {
        const exists = await invoke<boolean>("path_exists", { path: trimmed });
        if (!exists) {
          toast(`工作目录不存在：${trimmed}`, "error");
          return;
        }
      } catch (e) {
        toast(`校验工作目录失败: ${e}`, "error");
        return;
      }
    }
    setReady(false);
    try {
      // 重启 pi 并传入新 cwd；sessionPath=null 表示新建/沿用默认会话
      await invoke("restart_pi", { cwd: trimmed || null, sessionPath: null });
      setWorkdirPersist(trimmed);
      setTurns([]); currentTurnId.current = null; currentMsgId.current = null;
      pendingTextRef.current.clear(); pendingThinkingRef.current.clear();
      setPreviewPath(null);
      setReady(true);
      toast(trimmed ? `工作目录已切换：${trimmed}` : "已清除工作目录（沿用默认）", "success");
      await refreshState();
      await refreshSessions();
      // 重启后 pi 可能自动加载了某个会话，读取其历史确保 UI 与 pi 实际上下文一致
      await loadHistory();
    } catch (e) {
      // restart_pi 失败：旧 pi 已被 stop，必须重新拉起原 pi（用旧 workdir），
      // 否则界面虽然 setReady(false) 但 pi 实际离线。
      setReady(false);
      toast(`切换工作目录失败: ${e}（正在恢复原 Pi）`, "error");
      try {
        await invoke("restart_pi", { cwd: workdirRef.current.trim() || null, sessionPath: null });
        setReady(true);
        await refreshState();
        await loadHistory();
      } catch (e2) {
        toast(`恢复 Pi 失败: ${e2}`, "error");
      }
    }
  }, [busy, toast, setWorkdirPersist, refreshState, refreshSessions, loadHistory]);
  const pickWorkdir = useCallback(async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (!selected) return;
      const dir = Array.isArray(selected) ? selected[0] : selected;
      if (dir) setWorkdir(dir);
    } catch (e) { toast(`选择目录失败: ${e}`, "error"); }
  }, [toast]);

  // ====== 命令面板补全 ======
  const onCmdSelect = useCallback((text: string) => {
    setInput(text);
    setShowCmdPalette(false);
    setTimeout(() => {
      const ta = document.querySelector(".composer-inner textarea") as HTMLTextAreaElement;
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }, 0);
  }, []);

  const send = async (text?: string, attachmentOverride?: string[]) => {
    const rawMsg = (text ?? input).trim();
    const activeAttachments = attachmentOverride ?? attachments;
    // 支持只发附件：文本为空但有附件时，用默认文案发送
    if (!rawMsg && activeAttachments.length === 0) return;
    if (busy) { toast("Pilot 思考中，请等待当前任务完成或中断后再发送", "info"); return; }
    if (!ready) { toast("Pilot 未连接，请稍候", "info"); return; }
    // 预览模式下若 pi 正忙，提示用户：续聊需要重启 pi 会中断当前输出
    if (previewPath && previewPath !== sessionFileRef.current && busy) {
      toast("Pilot 正在输出，续聊历史会话会中断当前任务，请先等待或中断", "info"); return;
    }
    // 若处于预览模式（浏览的历史会话 != 当前活动会话），发消息前先真正切换。
    // 关键：用 restart_pi --session <path> 重启 pi 进程来续聊历史会话。
    // 之所以不用 switch_session RPC：pi RPC 进程与活动会话强绑定，
    // switch_session 在 RPC 模式下不可靠（实际不切换或创建空分支），
    // 导致"历史会话发消息后 AI 像失忆"——消息进了别的会话。
    // pi --session <path> 是官方文档的续聊方式（pi.dev/docs/quickstart#continue-later），
    // 重启进程虽然慢一点但 100% 可靠地加载历史会话上下文。
    if (previewPath && previewPath !== sessionFileRef.current) {
      try {
        setReady(false);
        await invoke("restart_pi", { cwd: workdirRef.current.trim() || null, sessionPath: previewPath });
        setPreviewPath(null);
        setReady(true);
        await refreshState();
        // 从 pi 重新读取该会话的消息（确保 UI 与 pi 实际加载的会话一致）
        await loadHistory();
      } catch (e) {
        setReady(true);
        toast(`切换会话失败: ${e}`, "error"); return;
      }
    }
    if (rawMsg.startsWith("/")) {
      const cmd = rawMsg.toLowerCase();
      // /new 新建会话；其它斜杠命令透传给 pi（由 pi 处理，如 /compact /name /model 等）
      if (cmd === "/new") { setInput(""); newSession(); return; }
      if (cmd === "/help") {
        setInput("");
        toast("/new 新建会话 · /compact 压缩上下文 · 其它 / 命令透传给 Pi（如 /name、/model）", "info");
        return;
      }
      if (cmd === "/compact") { setInput(""); compactNow(); return; }
      // 注意：Pi 没有 /clear 命令（会话为 append-only，无法清空），曾把 /clear 当作新建会话，
      //       语义混淆，已移除。如需清空请用 /new 新建会话。
    }
    if (pendingNewSessionRef.current) {
      try {
        await invoke("send_command", { command: { type: "new_session" } });
        pendingNewSessionRef.current = false;
        await refreshState();
      } catch (e) {
        toast(`新建会话失败: ${e}`, "error");
        return;
      }
    }
    // 拼接附件路径到消息（Pi 可读取这些路径的文件内容）
    // 文本为空但有附件时，用默认文案让 AI 知道用户意图是分析附件
    const userText = rawMsg || "请分析这些附件文件。";
    let finalMsg = userText;
    if (activeAttachments.length > 0) {
      const attachList = activeAttachments.map((p) => {
        const name = p.split(/[\\/]/).pop() || p;
        return `- ${p}（${name}）`;
      }).join("\n");
      finalMsg = `${userText}\n\n附件文件：\n${attachList}`;
    }
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    currentTurnId.current = turnId; currentMsgId.current = null;
    pendingTextRef.current.clear(); pendingThinkingRef.current.clear();
    setTurns((prev) => [...prev, { id: turnId, userMessage: userText, assistantMsgs: [], toolCalls: {}, status: "streaming" }]);
    setInput(""); setAttachments([]); setAutoFollow(true);
    try {
      await invoke("send_command", { command: { type: "prompt", message: finalMsg } });
    } catch (e) {
      toast(`发送失败: ${e}`, "error");
      setTurns((prev) => prev.map((t) => t.id === turnId ? { ...t, status: "done" } : t));
    }
  };

  const toggleTool = (turnId: string, toolId: string) => {
    setTurns((prev) => prev.map((t) => t.id === turnId
      ? { ...t, toolCalls: { ...t.toolCalls, [toolId]: { ...t.toolCalls[toolId], expanded: !t.toolCalls[toolId].expanded } } }
      : t));
  };

  // ====== AI 消息操作：复制 + 重新生成 ======
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const copyMessage = useCallback(async (msgId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMsgId(msgId);
      setTimeout(() => setCopiedMsgId((cur) => (cur === msgId ? null : cur)), 1500);
      toast("已复制到剪贴板", "success");
    } catch (e) {
      toast(`复制失败: ${e}`, "error");
    }
  }, [toast]);
  // 重新生成：用同一 turn 的 userMessage 重新发送（Pi 是 append-only，
  // 会在会话末尾追加新的一轮问答，旧回答保留。这是最简单可靠的"重新生成"）
  const regenerate = useCallback((userMessage: string) => {
    if (!userMessage) return;
    if (busy) { toast("Pilot 思考中，请等待当前任务完成或中断后再重新生成", "info"); return; }
    if (!ready) { toast("Pilot 未连接，请稍候", "info"); return; }
    send(userMessage);
  }, [busy, ready, send, toast]);

  // ====== 派生数据 ======
  const contextPercent = sessionStats?.contextUsage?.percent ?? 0;
  const contextClass = contextPercent > 80 ? "high" : contextPercent > 50 ? "mid" : "low";
  const inputCanSend = ready && !busy && input.trim().length > 0;
  const modelName = currentModel?.name || piState?.model?.name || "未设置";
  // 日志过滤
  const filteredLogs = logs.filter((l) => {
    if (logFilter !== "all" && l.type !== logFilter) return false;
    if (logSearch.trim() && !l.text.toLowerCase().includes(logSearch.toLowerCase())) return false;
    return true;
  });
  const stderrCount = logs.filter((l) => l.type === "stderr").length;
  const displaySessionTitle = (session: SessionInfo) => sessionTitleOverrides[session.path] || session.title || session.name || "未命名会话";
  // 会话搜索过滤（匹配文件名 / 首条消息标题 / 工作目录）
  const filteredSessions = sessionSearch.trim()
    ? sessions.filter((s) => {
        const q = sessionSearch.toLowerCase();
        return (s.name || "").toLowerCase().includes(q)
          || displaySessionTitle(s).toLowerCase().includes(q)
          || (s.cwd || "").toLowerCase().includes(q)
          || (sessionProjectOverrides[s.path] || "").toLowerCase().includes(q);
      })
    : sessions;

  // 当前会话的 cwd（用于文件浏览器初始定位）
  const currentSessionCwd = useMemo(() => {
    if (!currentSessionPath) return undefined;
    const match = sessions.find((s) => s.path === currentSessionPath);
    return match?.cwd;
  }, [currentSessionPath, sessions]);

  const projectSessions = useMemo(() => {
    const groups = new Map<string, SessionInfo[]>();
    for (const s of filteredSessions) {
      const projectName = sessionProjectOverrides[s.path] || naturalProjectName(s);
      if (!groups.has(projectName)) groups.set(projectName, []);
      groups.get(projectName)!.push(s);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredSessions, sessionProjectOverrides]);

  const availableProjectNames = useMemo(() => Array.from(new Set(
    sessions.map((session) => sessionProjectOverrides[session.path] || naturalProjectName(session))
  )).sort((a, b) => a.localeCompare(b)), [sessionProjectOverrides, sessions]);

  // 聊天框模型下拉框只显示已配置 API Key 且有模型列表的 provider 的模型。
  // 不合并 Pi 原生返回的模型（那些 provider 可能没配 API Key，选了也没用）。
  const visibleModels = useMemo(() => {
    if (!modelsConfig) return [];
    const configured = Object.entries(modelsConfig.providers)
      .filter(([_, p]) => p.apiKey && p.models.length > 0);
    if (configured.length === 0) return [];
    return configured.flatMap(([id, p]) =>
      p.models.map(m => ({ id: m.id, name: m.name, provider: id } as ModelInfo))
    );
  }, [modelsConfig]);

  const renderAssistantSession = (session: SessionInfo, projectItem = false) => {
    const active = (previewPath || currentSessionPath) === session.path;
    const isRenaming = renamingPath === session.path;
    const title = displaySessionTitle(session);
    return (
      <div key={session.path} className={`assistant-history-row ${active ? "active" : ""} ${projectItem ? "project-item" : ""} ${sessionMenuPath === session.path ? "menu-open" : ""}`}>
        {isRenaming ? (
          <label className="assistant-session-rename">
            <Pencil size={13} />
            <input
              autoFocus
              value={renameInput}
              onChange={(event) => setRenameInput(event.target.value)}
              onBlur={() => confirmRename()}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); confirmRename(); }
                if (event.key === "Escape") { event.preventDefault(); setRenamingPath(null); }
              }}
              aria-label="会话名称"
            />
          </label>
        ) : (
          <button className="assistant-history-main" onClick={() => { setSessionMenuPath(null); switchSession(session.path); }} title={title}>
            <MessageSquare size={14} />
            <span><strong>{title}</strong><small>{formatSessionTime(session.mtime)}</small></span>
          </button>
        )}
        {!isRenaming && (
          <button
            className="assistant-session-more"
            onClick={(event) => { event.stopPropagation(); setSessionMenuPath(sessionMenuPath === session.path ? null : session.path); }}
            title="管理会话"
            aria-label={`管理会话：${title}`}
          >
            <MoreHorizontal size={15} />
          </button>
        )}
        {sessionMenuPath === session.path && (
          <>
            <button className="session-menu-dismiss" onClick={() => setSessionMenuPath(null)} aria-label="关闭会话菜单" />
            <div className="assistant-session-menu">
              <button onClick={() => startRename(session)}><Pencil size={14} />重命名</button>
              <button onClick={() => startMoveSession(session)}><FolderInput size={14} />移动到项目</button>
              <button className="danger" onClick={(event) => deleteSession(session.path, event)}><Trash2 size={14} />删除</button>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="app">
      {/* ============ 顶栏 ============ */}
      <header className="header">
        <div className="app-brand">
          <span className="app-brand-mark">HT</span>
          <span className="app-brand-copy"><strong>Logistic</strong><span>Workspace</span></span>
        </div>
        <span className={`header-status ${ready ? (busy ? "busy" : "ready") : "error"}`}>
          <span className="dot" />
          {ready ? (busy ? "思考中" : "就绪") : "未连接"}
        </span>
        <div className="header-spacer" />
        <div className="header-service-health" aria-label="服务状态">
          <span className={ready ? "online" : "offline"} title={ready ? "Pi 已在线" : "Pi 未连接"}><i />Pi</span>
          <span className={toolsList.length > 0 ? "online" : "offline"} title={toolsList.length > 0 ? "Sidecar 已在线" : "Sidecar 未连接"}><i />Sidecar</span>
        </div>
        {/* 工作目录：右移至 spacer 之后，与日志/主题一组，左侧保持品牌+状态更干净 */}
        <button
          className="icon-btn workdir-btn"
          onClick={async () => {
            try {
              const selected = await openDialog({ directory: true, multiple: false, defaultPath: workdir || undefined });
              if (!selected) return;
              const dir = Array.isArray(selected) ? selected[0] : selected;
              if (dir) await applyWorkdir(dir);
            } catch (e) { toast(`选择目录失败: ${e}`, "error"); }
          }}
          title={workdir ? `工作目录：${workdir}（点击切换）` : "设置工作目录（输入输出文件都存这里）"}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
        </button>
        {/* 主题切换 */}
        <button
          className="icon-btn"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title={theme === "dark" ? "切换到浅色" : "切换到深色"}
        >
          {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
        {/* 调试日志 */}
        <button className={`icon-btn log-toggle ${stderrCount > 0 ? "has-warn" : ""}`} onClick={() => setShowLogViewer(true)} title="调试日志">
          <ClipboardList size={15} />
          {logs.length > 0 && <span className="badge">{logs.length}</span>}
        </button>
        {/* 窗口控制（自定义标题栏） */}
        <div className="window-controls">
          <button className="win-btn" onClick={() => getCurrentWindow().minimize()} title="最小化" aria-label="最小化">
            <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="5.5" width="9" height="1.2" rx="0.6" fill="currentColor"/></svg>
          </button>
          <button className="win-btn" onClick={() => getCurrentWindow().toggleMaximize()} title="最大化" aria-label="最大化">
            <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="8" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
          </button>
          <button className="win-btn close" onClick={() => getCurrentWindow().close()} title="关闭" aria-label="关闭">
            <svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
          </button>
        </div>
      </header>

      {/* ============ 主体 ============ */}
      <div className={`body workspace-mode ${workspaceView}-view`}>
        <aside className="mode-rail" aria-label="页面切换">
          <nav className="mode-rail-list">
            <button
              className={`mode-rail-item ${workspaceView === "assistant" ? "active" : ""}`}
              onClick={() => setWorkspaceView("assistant")}
              title="AI 助手"
            >
              <MessageSquare size={19} />
              <span>AI 助手</span>
            </button>
            <button
              className={`mode-rail-item ${workspaceView === "tool" ? "active" : ""}`}
              onClick={() => setWorkspaceView("tool")}
              title="物流工具"
            >
              <Wrench size={19} />
              <span>工具</span>
            </button>
            <button
              className={`mode-rail-item ${workspaceView === "data" ? "active" : ""}`}
              onClick={() => setWorkspaceView("data")}
              title="物流数据"
            >
              <ChartNoAxesCombined size={19} />
              <span>物流数据</span>
            </button>
          </nav>
          <div className="mode-rail-footer">
            <button
              ref={railModelBtnRef}
              className="mode-rail-model"
              onClick={() => showModelDropdown ? setShowModelDropdown(false) : (refreshModels(), openDropdown(railModelBtnRef.current, "model"))}
              title={`选择模型：${modelName}`}
            >
              <span className="mode-rail-footer-icon"><Bot size={16} /></span>
              <span>模型</span>
            </button>
            <button
              className="mode-rail-settings"
              onClick={() => { refreshEnvKeys(); loadSystemPrompt(systemPromptPath); loadModelsConfig(); setShowSettings(true); }}
              title="设置"
            >
              <span className="mode-rail-footer-icon"><Settings size={16} /></span>
              <span>设置</span>
            </button>
          </div>
        </aside>

        {workspaceView === "assistant" && <aside className="assistant-sidebar" aria-label="AI 助手导航">
          <div className="assistant-sidebar-top">
            <button
              className={`assistant-entry ${assistantSidebarView === "quick" ? "active" : ""}`}
              onClick={newSession}
            >
              <span className="assistant-entry-icon"><MessageSquare size={17} /></span>
              <span><strong>快速问答</strong><small>新建对话 · 按项目整理</small></span>
            </button>
            <button className="assistant-new-chat" onClick={newSession} disabled={busy} title="新建快速问答">
              <Plus size={16} />
            </button>
            <button
              className={`assistant-entry assistant-files-entry ${assistantSidebarView === "files" ? "active" : ""}`}
              onClick={() => setAssistantSidebarView("files")}
            >
              <span className="assistant-entry-icon"><Files size={17} /></span>
              <span><strong>项目文件</strong><small>{attachments.length > 0 ? `已选 ${attachments.length} 个文件` : "选择任务上下文"}</small></span>
              <ChevronRight size={15} />
            </button>
          </div>

          {assistantSidebarView === "files" ? (
            <div className="assistant-files-view">
              <header className="assistant-files-header">
                <span>
                  <strong>工作文件</strong>
                  <small title={workdir || currentSessionCwd || undefined}>{workdir || currentSessionCwd || "选择工作目录后显示项目文件"}</small>
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const selected = await openDialog({ directory: true, multiple: false, defaultPath: workdir || undefined });
                      if (!selected) return;
                      const dir = Array.isArray(selected) ? selected[0] : selected;
                      if (dir) await applyWorkdir(dir);
                    } catch (error) { toast(`选择目录失败: ${error}`, "error"); }
                  }}
                  title="选择工作目录"
                ><FolderOpen size={16} /></button>
              </header>
              <div className="assistant-files-browser">
                <FileBrowser
                  currentCwd={workdir || currentSessionCwd}
                  compact
                  hideTabs
                  selectionMode
                  selectedFiles={attachments}
                  onToggleFile={toggleProjectFile}
                  onPickFile={pickFileFromBrowser}
                  onRunTool={runToolFromBrowser}
                />
              </div>
            </div>
          ) : (
            <>
              <div className="assistant-history-heading">
                <strong>项目</strong>
                <span>{projectSessions.length}</span>
              </div>
              {sessions.length > 0 && (
                <label className="assistant-history-search">
                  <Search size={14} />
                  <input value={sessionSearch} onChange={(event) => setSessionSearch(event.target.value)} placeholder="搜索项目或对话" />
                </label>
              )}

              <div className="assistant-history-list">
                {filteredSessions.length === 0 ? (
                  <div className="assistant-history-empty">
                    <MessageSquare size={22} />
                    <span>{sessions.length === 0 ? "还没有项目对话" : "没有匹配的项目或对话"}</span>
                  </div>
                ) : projectSessions.map(([projectName, groupSessions]) => {
                  const collapsed = collapsedProjects.has(projectName);
                  return (
                    <section className="assistant-project-group" key={projectName}>
                      <button className="assistant-project-heading" onClick={() => toggleProjectCollapse(projectName)}>
                        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        <FolderOpen size={14} />
                        <strong>{projectName}</strong>
                        <span>{groupSessions.length}</span>
                      </button>
                      {!collapsed && groupSessions.map((session) => renderAssistantSession(session, true))}
                    </section>
                  );
                })}
              </div>
            </>
          )}
        </aside>}

        {workspaceView === "tool" && <aside className="context-sidebar" aria-label="文件管理">
          <header className="context-sidebar-header">
            <div>
              <strong>工作文件</strong>
              <small title={workdir || currentSessionCwd || undefined}>{workdir || currentSessionCwd || "选择工作目录后显示项目文件"}</small>
            </div>
            <button
              className="context-header-button"
              onClick={async () => {
                try {
                  const selected = await openDialog({ directory: true, multiple: false, defaultPath: workdir || undefined });
                  if (!selected) return;
                  const dir = Array.isArray(selected) ? selected[0] : selected;
                  if (dir) await applyWorkdir(dir);
                } catch (error) { toast(`选择目录失败: ${error}`, "error"); }
              }}
              title="打开工作目录"
            ><FolderOpen size={16} /></button>
          </header>

          <div className="context-tabs" role="tablist">
            <button className={contextPanelTab === "files" ? "active" : ""} onClick={() => setContextPanelTab("files")}>
              <FolderOpen size={14} />项目文件
            </button>
            <button className={contextPanelTab === "outputs" ? "active" : ""} onClick={() => setContextPanelTab("outputs")}>
              <FileOutput size={14} />最近输出
            </button>
          </div>

          <div className="context-sidebar-content">
            {contextPanelTab === "files" && (
              <FileBrowser
                currentCwd={workdir || currentSessionCwd}
                compact
                hideTabs
                onPickFile={pickFileFromBrowser}
                onRunTool={runToolFromBrowser}
              />
            )}

            {contextPanelTab === "outputs" && (
              <div className="context-output-list">
                {toolOutputs.length === 0 ? (
                  <div className="context-empty">
                    <Box size={28} />
                    <span>工具生成的文件会出现在这里</span>
                  </div>
                ) : toolOutputs.map((output) => {
                  const name = output.path.split(/[\\/]/).pop() || output.path;
                  return (
                    <div
                      key={`${output.path}-${output.time}`}
                      className="context-output-item"
                      title={output.path}
                    >
                      <span className="context-output-icon"><Sheet size={16} /></span>
                      <span className="context-output-copy">
                        <strong>{name}</strong>
                        <small>{output.toolName} · {new Date(output.time).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</small>
                      </span>
                      <span className="context-output-actions">
                        <button type="button" onClick={() => openToolOutput(output)} title="打开文件" aria-label={`打开 ${name}`}>
                          <ExternalLink size={14} />
                        </button>
                        <button type="button" onClick={() => locateToolOutput(output)} title="在文件管理器中定位" aria-label={`定位 ${name}`}>
                          <FolderOpen size={14} />
                        </button>
                        <button type="button" onClick={() => addToolOutputToChat(output)} title="加入聊天附件" aria-label={`将 ${name} 加入聊天附件`}>
                          <Paperclip size={14} />
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>}

        {workspaceView === "data" && (
          <LogisticsDataPanel
            onSendToAssistant={(message) => {
              setWorkspaceView("assistant");
              send(message);
            }}
          />
        )}

        {/* 左侧栏 */}
        {false && (
        <aside className="sidebar legacy-sidebar" aria-hidden="true">
          {/* 会话列表：flex:1 撑满上半部分，把"物流工具"推到中间偏下位置 */}
          <div className="sidebar-section" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
            <div className="sidebar-section-header">
              <span className="sidebar-title">会话管理</span>
              <button className="sidebar-new-btn" onClick={newSession} disabled={busy}>+ 新建</button>
            </div>
            {/* 搜索框 */}
            {sessions.length > 0 && (
              <div className="session-search-wrap">
                <input
                  className="session-search"
                  type="text"
                  placeholder="搜索会话…"
                  value={sessionSearch}
                  onChange={(e) => setSessionSearch(e.target.value)}
                />
              </div>
            )}
            <div className="session-list">
              {filteredSessions.length === 0 ? (
                <div style={{ padding: "12px 8px", fontSize: 12, color: "var(--fg-muted)" }}>
                  {sessions.length === 0 ? "暂无历史会话" : "无匹配会话"}
                </div>
              ) : projectSessions.map(([projectName, groupSessions]) => {
                const collapsed = collapsedProjects.has(projectName);
                return (
                <div key={projectName} className="session-group">
                  <div className="session-group-header" onClick={() => toggleProjectCollapse(projectName)} style={{ cursor: "pointer" }}>
                    <span className="session-group-icon">{collapsed ? "▸" : "▾"}</span>
                    <span className="session-group-title" title={projectName}>
                      {projectName}
                    </span>
                    <span className="session-group-count">{groupSessions.length}</span>
                  </div>
                  {!collapsed && (
                  <div className="session-group-items">
                    {groupSessions.map((s) => {
                      const isActive = currentSessionPath === s.path;
                      const isPreviewing = previewPath === s.path && !isActive;
                      const isRenaming = renamingPath === s.path;
                      return (
                        <div
                          key={s.path}
                          className={`session-item ${isActive ? "active" : ""} ${isPreviewing ? "previewing" : ""}`}
                          onClick={() => !isRenaming && switchSession(s.path)}
                        >
                          <div className="session-info">
                            {isRenaming ? (
                              <input
                                className="session-rename-input"
                                autoFocus
                                value={renameInput}
                                onChange={(e) => setRenameInput(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); confirmRename(); }
                                  if (e.key === "Escape") { e.preventDefault(); setRenamingPath(null); }
                                }}
                                onBlur={() => confirmRename()}
                              />
                            ) : (
                              <div className="session-name">{s.title || "未命名会话"}</div>
                            )}
                          </div>
                          {isActive && !isRenaming && (
                            <div className="session-actions">
                              <button className="session-action-btn" onClick={(e) => { e.stopPropagation(); startRename(); }} title="重命名">✎</button>
                            </div>
                          )}
                          <button className="session-delete" onClick={(e) => deleteSession(s.path, e)} title="删除">✕</button>
                        </div>
                      );
                    })}
                  </div>
                  )}
                </div>
                );
              })}
            </div>
          </div>

          {/* 物流工具导航：从中间工具区拆出，放左侧栏
              点击切换中间执行区的当前工具（命令式调用 ToolsPanel.selectTool） */}
          <div className="sidebar-section sidebar-tools-nav">
            <div className="sidebar-section-header">
              <span className="sidebar-title">物流工具</span>
            </div>
            <div className="sidebar-tools-list">
              {toolsList.length === 0 ? (
                <div className="sidebar-tools-empty">等待 sidecar…</div>
              ) : toolsList.map((t) => (
                <button
                  key={t.id}
                  className={`sidebar-tool-item ${activeToolMirrored?.id === t.id ? "active" : ""}`}
                  onClick={() => toolsPanelRef.current?.selectTool(t.id)}
                  title={t.description}
                >
                  <span className="sidebar-tool-name">{t.name}</span>
                  <span className="sidebar-tool-meta">{t.input.toUpperCase()} → {t.output.toUpperCase()}</span>
                </button>
              ))}
            </div>
          </div>

          {/* sidebar 底部状态条（2 行 + 进度条），固定在侧栏底部：
              第 1 行：状态点 + 状态文字 · 模型名
              第 2 行：权限模式 · 上下文%
              末行：全宽上下文进度条 */}
          <div className="sidebar-footer-bar">
            <div className="sidebar-footer-row1" title={`模型：${currentModel?.name ?? "未连接"}`}>
              <span className={`sidebar-footer-dot ${ready ? (busy ? "busy" : "ready") : "error"}`} />
              {(!ready || busy) && (
                <>
                  <span className="sidebar-footer-state">{ready ? "思考中" : "未连接"}</span>
                  <span className="sidebar-footer-sep">·</span>
                </>
              )}
              <span className="sidebar-footer-model">{currentModel?.name ?? "—"}</span>
            </div>
            <div className="sidebar-footer-row2" title={permissionModeLabel}>
              <span className="sidebar-footer-perm">{permissionMode === "cautious" ? "审慎模式" : permissionMode === "workspace" ? "工作台模式" : "全信任模式"}</span>
              {contextPercent > 0 && (
                <>
                  <span className="sidebar-footer-sep">·</span>
                  <span className="sidebar-footer-pct">上下文 {contextPercent.toFixed(0)}%</span>
                </>
              )}
            </div>
            {contextPercent > 0 && (
              <div className="sidebar-footer-ctxbar" title={`上下文 ${contextPercent.toFixed(0)}% · ${sessionStats?.contextUsage?.tokens ?? 0} / ${sessionStats?.contextUsage?.contextWindow ?? 0} tokens`}>
                <div className={`sidebar-footer-ctx-fill ${contextClass}`} style={{ width: `${Math.min(contextPercent, 100)}%` }} />
              </div>
            )}
          </div>
        </aside>
        )}

        {/* 主区 */}
        <main className={`main workspace-main ${turns.length === 0 ? "main-empty" : ""}`}>
          <div className={`assistant-surface ${workspaceView === "assistant" ? "active" : ""}`}>
          <div className="messages" ref={messagesRef} onScroll={handleScroll}>
            <div className="messages-inner">
              {switching ? (
                <div className="messages-loading">
                  <span className="thinking-dots"><span className="dot-pulse" /><span className="dot-pulse" /><span className="dot-pulse" /></span>
                  <span className="messages-loading-text">加载会话历史…</span>
                </div>
              ) : turns.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-assistant-row">
                    <img className="empty-pilot-avatar" src={pilotAvatar} alt="Pilot" />
                    <div>
                      <div className="empty-mark">PILOT 工作台</div>
                      <h3>今天想处理什么物流工作？</h3>
                      <p>我可以结合左侧选中的项目文件，帮你解读单证、总结数据、起草邮件或继续调用业务工具。</p>
                    </div>
                  </div>
                  {attachments.length > 0 && (
                    <section className="assistant-task-files">
                      <header><strong>本次任务使用的文件</strong><span>{attachments.length} 个文件</span></header>
                      <div>
                        {attachments.map((path) => {
                          const name = path.split(/[\\/]/).pop() || path;
                          return (
                            <span className="assistant-task-file" key={path} title={path}>
                              <Paperclip size={14} />
                              <span>{name}</span>
                              <button type="button" onClick={() => removeAttachment(path)} title="移除文件">×</button>
                            </span>
                          );
                        })}
                      </div>
                    </section>
                  )}
                  <section className="empty-suggestion-section">
                    <header className="empty-suggestion-header">
                      <span>快捷操作</span>
                      <button type="button" onClick={createQuickAction} title="添加快捷操作" aria-label="添加快捷操作"><Plus size={15} /></button>
                    </header>
                    <div className="empty-suggestion-grid">
                      {quickActions.map((action) => (
                        <article className="quick-action-card" key={action.id}>
                          <button className="quick-action-main" onClick={() => runQuickAction(action)}>
                            <span className="quick-action-icon"><QuickActionGlyph icon={action.icon} /></span>
                            <span className="quick-action-copy"><strong>{action.title}</strong><small>{action.description}</small></span>
                            <ChevronRight size={15} />
                          </button>
                          <button className="quick-action-edit" onClick={() => setEditingQuickAction({ ...action })} title={`编辑：${action.title}`} aria-label={`编辑快捷操作：${action.title}`}><Pencil size={13} /></button>
                        </article>
                      ))}
                      {quickActions.length === 0 && <button className="quick-action-empty" type="button" onClick={createQuickAction}><Plus size={15} />添加第一个快捷操作</button>}
                    </div>
                  </section>
                </div>
              ) : turns.map((turn) => (
                <div key={turn.id} className="turn">
                  {turn.userMessage && (
                    <div className="msg user">
                      <div className="msg-content"><div className="msg-bubble user-bubble">{turn.userMessage}</div></div>
                    </div>
                  )}
                  {turn.assistantMsgs.length === 0 && turn.status === "streaming" ? (
                    <div className="msg assistant">
                      <div className="msg-author"><img className="avatar pilot-avatar" src={pilotAvatar} alt="Pilot" /><span className="author-name">Pilot</span></div>
                      <div className="msg-content">
                        <div className="msg-bubble assistant-bubble">
                          <span className="thinking-dots"><span className="dot-pulse" /><span className="dot-pulse" /><span className="dot-pulse" /></span>
                        </div>
                      </div>
                    </div>
                  ) : turn.assistantMsgs.map((msg) => (
                    <div key={msg.id} className={`msg assistant ${msg.streaming ? "streaming" : ""}`}>
                      <div className="msg-author"><img className="avatar pilot-avatar" src={pilotAvatar} alt="Pilot" /><span className="author-name">Pilot</span></div>
                      <div className="msg-content">
                        {msg.thinking && (
                          <details className="reasoning">
                            <summary><span className="reasoning-chevron">▸</span>思维链<span className="reasoning-count">{msg.thinking.length} 字</span></summary>
                            <div className="reasoning-body">{msg.thinking}</div>
                          </details>
                        )}
                        <div className="msg-bubble assistant-bubble">
                          <Markdown content={msg.text} streaming={msg.streaming} />
                        </div>
                        {msg.error && (
                          <div className="assistant-message-error" role="status">
                            <span>本次回答已中断</span>
                            <small>{msg.error}</small>
                          </div>
                        )}
                        {msg.toolCallIds.length > 0 && (
                          <div className="tool-list">
                            {msg.toolCallIds.map((tcId) => {
                              const tc = turn.toolCalls[tcId];
                              return tc ? <ToolCard key={tcId} tool={tc} onToggle={() => toggleTool(turn.id, tcId)} /> : null;
                            })}
                          </div>
                        )}
                        {/* AI 消息操作：复制 + 重新生成（非 streaming 时显示）*/}
                        {!msg.streaming && msg.text && (
                          <div className="msg-actions">
                            <button
                              className="msg-action-btn"
                              onClick={() => copyMessage(msg.id, msg.text)}
                              title="复制回答"
                            >{copiedMsgId === msg.id ? "✓ 已复制" : "⧉ 复制"}</button>
                            {turn.userMessage && (
                              <button
                                className="msg-action-btn"
                                onClick={() => regenerate(turn.userMessage)}
                                title="基于同一问题重新生成"
                              >↻ 重新生成</button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <button className={`scroll-btn ${showScrollBtn ? "visible" : ""}`} onClick={() => scrollToBottom(true)} title="回到底部">↓</button>
          </div>

          {/* 输入框 */}
          <div
            className={`composer ${dragOver ? "drag-over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDragOver(true); }}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
            onDrop={handleFileDrop}
          >
            {showCmdPalette && (
              <CommandPalette input={input} index={cmdIndex} setIndex={setCmdIndex} onSelect={onCmdSelect} />
            )}
            <div className="composer-shell">
              {attachments.length > 0 && (
                <div className="attachment-list">
                  {attachments.map((path) => {
                    const name = path.split(/[\\/]/).pop() || path;
                    const ext = name.split(".").pop()?.toLowerCase() || "";
                    const icon = ["xlsx", "xls", "csv"].includes(ext) ? <span className="fb-icon-badge excel">XLS</span> : ["doc", "docx"].includes(ext) ? <span className="fb-icon-badge doc">DOC</span> : ext === "pdf" ? <span className="fb-icon-badge doc">PDF</span> : ["png", "jpg", "jpeg"].includes(ext) ? <span className="fb-icon-badge img">IMG</span> : <span className="fb-icon-badge text">FILE</span>;
                    return (
                      <div key={path} className="attachment-chip" title={path}>
                        <span className="attachment-icon">{icon}</span>
                        <span className="attachment-name">{name}</span>
                        <button
                          type="button"
                          className="attachment-remove"
                          onClick={() => removeAttachment(path)}
                          title="移除"
                        >×</button>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="composer-inner">
                <textarea
                  value={input}
                  onChange={(e) => { setInput(e.target.value); setShowCmdPalette(e.target.value.startsWith("/")); }}
                  onKeyDown={(e) => {
                    if (showCmdPalette) {
                      if (e.key === "ArrowDown") { e.preventDefault(); setCmdIndex((i) => Math.min(i + 1, 7)); return; }
                      if (e.key === "ArrowUp") { e.preventDefault(); setCmdIndex((i) => Math.max(i - 1, 0)); return; }
                      if (e.key === "Escape") { e.preventDefault(); setShowCmdPalette(false); return; }
                      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                        const cmdEl = document.querySelector(".cmd-item.active") as HTMLElement;
                        if (cmdEl) { e.preventDefault(); cmdEl.click(); return; }
                      }
                    }
                    if (e.key === "Escape") { e.preventDefault(); setInput(""); return; }
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                  }}
                  onInput={(e) => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 220) + "px"; }}
                  placeholder={ready ? "输入单据制作、数据分析或物流问题…" : "正在连接 Pi…"}
                  rows={1}
                  disabled={!ready}
                />
                {busy ? (
                  <button className="abort-btn" onClick={abort} title="中断">中断</button>
                ) : (
                  <button className="send-btn" onClick={() => send()} disabled={!inputCanSend} title="发送" aria-label="发送"><ArrowUp size={17} /></button>
                )}
              </div>
              {/* 工具栏：左侧操作组（附件/模型/权限），右侧工具调用，中间 spacer 分隔 */}
              <div className="composer-toolbar">
                <div className="composer-pill-group">
                  <button
                    type="button"
                    className="composer-pill"
                    onClick={pickAttachments}
                    title="添加附件（Excel/Word/PDF 等）"
                  >
                    <Paperclip size={15} />
                  </button>
                  <button
                    ref={modelBtnRef}
                    type="button"
                    className="composer-pill composer-pill-model"
                    onClick={() => showModelDropdown ? setShowModelDropdown(false) : (refreshModels(), openDropdown(modelBtnRef.current, "model"))}
                    title={`模型：${modelName}`}
                  >
                    <span className="composer-pill-text">{modelName}</span>▾
                  </button>
                  <button
                    ref={permBtnRef}
                    type="button"
                    className="composer-pill"
                    onClick={() => showPermissionDropdown ? setShowPermissionDropdown(false) : openDropdown(permBtnRef.current, "perm")}
                    title={`权限模式：${permissionModeLabel}`}
                  >
                    {permissionMode === "cautious" ? "审慎" : permissionMode === "workspace" ? "工作台" : "信任"}▾
                  </button>
                </div>
                <div className="composer-pill-group">
                  <button type="button" className="composer-pill composer-tool-call" onClick={() => { setInput("/"); setShowCmdPalette(true); }} title="斜杠命令 / 工具调用" aria-label="工具调用">
                    <Wrench size={15} />
                  </button>
                </div>
              </div>
              {/* 下拉框用 Portal 渲染到 body，脱离所有父容器 overflow 裁切 */}
              {(showModelDropdown || showPermissionDropdown) && dropdownPos && createPortal(
                <>
                  <div className="dropdown-overlay" onClick={() => { setShowModelDropdown(false); setShowPermissionDropdown(false); }} />
                  <div
                    className="model-dropdown-portal"
                    style={{ left: dropdownPos.left, bottom: dropdownPos.bottom, minWidth: dropdownPos.width }}
                  >
                    {showModelDropdown && (
                      visibleModels.length === 0 ? (
                        <div className="model-dropdown-empty">未找到可用模型，请在设置里配置并启用 API Key</div>
                      ) : visibleModels.map((m) => (
                        <button
                          type="button"
                          key={`${m.provider}/${m.id}`}
                          className={`model-dropdown-item ${currentModel?.id === m.id ? "active" : ""}`}
                          onClick={() => { setModel(m.provider, m.id); setShowModelDropdown(false); }}
                        >
                          <span className="model-dropdown-name">{m.name}</span>
                          <span className="model-dropdown-meta">
                            {m.provider}{m.contextWindow ? ` · ${(m.contextWindow/1000).toFixed(0)}K` : ""}{m.reasoning ? " · 推理" : ""}
                          </span>
                        </button>
                      ))
                    )}
                    {showPermissionDropdown && (
                      <>
                        <button
                          type="button"
                          className={`model-dropdown-item ${permissionMode === "cautious" ? "active" : ""}`}
                          onClick={() => { setPermissionModePersist("cautious"); setShowPermissionDropdown(false); }}
                        >
                          <span className="model-dropdown-name">审慎模式</span>
                          <span className="model-dropdown-meta">生成文件前确认，删除/外部请求必须确认</span>
                        </button>
                        <button
                          type="button"
                          className={`model-dropdown-item ${permissionMode === "workspace" ? "active" : ""}`}
                          onClick={() => { setPermissionModePersist("workspace"); setShowPermissionDropdown(false); }}
                        >
                          <span className="model-dropdown-name">工作台模式</span>
                          <span className="model-dropdown-meta">本地生成和分析自动执行，删除等重要修改才弹窗</span>
                        </button>
                        <button
                          type="button"
                          className={`model-dropdown-item ${permissionMode === "trust" ? "active" : ""}`}
                          onClick={() => { setPermissionModePersist("trust"); setShowPermissionDropdown(false); }}
                        >
                          <span className="model-dropdown-name">全信任模式</span>
                          <span className="model-dropdown-meta">所有已授权工具自动执行</span>
                        </button>
                      </>
                    )}
                  </div>
                </>,
                document.body
              )}
            </div>
          </div>
          </div>
          <section className={`tool-workbench ${workspaceView === "tool" ? "active" : ""}`}>
            <ToolsPanel
              ref={toolsPanelRef}
              onSendToAssistant={(message, attachmentPath) => {
                setWorkspaceView("assistant");
                setContextPanelTab("files");
                send(message, attachmentPath ? [attachmentPath] : undefined);
              }}
              onToolOutput={addToolOutput}
              onToolsChange={setToolsList}
              onActiveToolChange={setActiveToolMirrored}
              recentFiles={recentFiles}
              recentOutputs={toolOutputs}
            />
          </section>
        </main>
        {false && (
        <aside className="workspace-files legacy-workspace-files" aria-hidden="true">
          <FileBrowser
            currentCwd={workdir || currentSessionCwd}
            compact
            onPickFile={pickFileFromBrowser}
            onRunTool={runToolFromBrowser}
            recentFiles={recentFiles}
            toolOutputs={toolOutputs}
          />
        </aside>
        )}
      </div>

      {/* ============ Toast ============ */}
      <div className="toast-container">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>)}
      </div>

      {editingQuickAction && (
        <div className="modal-overlay" onClick={() => setEditingQuickAction(null)}>
          <div className="modal quick-action-modal" onClick={(event) => event.stopPropagation()}>
            <div className="quick-action-modal-heading">
              <div><strong>{quickActions.some((action) => action.id === editingQuickAction.id) ? "编辑快捷操作" : "添加快捷操作"}</strong><small>设置卡片显示内容和点击后的动作</small></div>
              <button type="button" onClick={() => setEditingQuickAction(null)} title="关闭" aria-label="关闭">×</button>
            </div>
            <div className="quick-action-form-grid">
              <label><span>名称</span><input value={editingQuickAction.title} onChange={(event) => setEditingQuickAction((current) => current ? { ...current, title: event.target.value } : current)} placeholder="例如：生成报价说明" autoFocus /></label>
              <label><span>卡片说明</span><input value={editingQuickAction.description} onChange={(event) => setEditingQuickAction((current) => current ? { ...current, description: event.target.value } : current)} placeholder="简短说明这个操作的用途" /></label>
              <label><span>点击动作</span><select value={editingQuickAction.kind} onChange={(event) => setEditingQuickAction((current) => current ? { ...current, kind: event.target.value as QuickActionKind } : current)}><option value="prompt">填写提示词</option><option value="files">打开项目文件</option><option value="tools">进入物流工具</option></select></label>
              <label><span>图标</span><select value={editingQuickAction.icon} onChange={(event) => setEditingQuickAction((current) => current ? { ...current, icon: event.target.value as QuickActionIcon } : current)}><option value="sparkles">智能操作</option><option value="document">文档</option><option value="chart">数据图表</option><option value="mail">邮件</option><option value="folder">文件夹</option><option value="tool">工具</option></select></label>
            </div>
            {editingQuickAction.kind === "prompt" && (
              <label className="quick-action-prompt-field"><span>提示词</span><textarea value={editingQuickAction.prompt} onChange={(event) => setEditingQuickAction((current) => current ? { ...current, prompt: event.target.value } : current)} placeholder="点击卡片后填入聊天框的提示词" rows={5} /></label>
            )}
            {editingQuickAction.kind === "prompt" && (
              <label className="quick-action-file-toggle"><input type="checkbox" checked={editingQuickAction.requiresFiles} onChange={(event) => setEditingQuickAction((current) => current ? { ...current, requiresFiles: event.target.checked } : current)} /><span><strong>需要项目文件</strong><small>没有选择文件时，先打开项目文件列表</small></span></label>
            )}
            <div className="quick-action-modal-actions">
              {quickActions.some((action) => action.id === editingQuickAction.id) ? <button className="quick-action-delete" type="button" onClick={deleteQuickAction}><Trash2 size={14} />删除</button> : <span />}
              <div><button className="btn-secondary" type="button" onClick={() => setEditingQuickAction(null)}>取消</button><button className="btn-primary" type="button" onClick={saveQuickAction}>保存</button></div>
            </div>
          </div>
        </div>
      )}

      {movingSessionPath && (
        <div className="modal-overlay" onClick={() => setMovingSessionPath(null)}>
          <div className="modal session-move-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">移动到项目</div>
            <p>选择已有项目，或输入一个新的项目名称。</p>
            <input
              className="modal-input"
              autoFocus
              list="session-project-options"
              value={moveProjectInput}
              onChange={(event) => setMoveProjectInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); confirmMoveSession(); }
                if (event.key === "Escape") setMovingSessionPath(null);
              }}
              placeholder="项目名称"
            />
            <datalist id="session-project-options">
              {availableProjectNames.map((name) => <option key={name} value={name} />)}
            </datalist>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setMovingSessionPath(null)}>取消</button>
              <button className="btn-primary" onClick={confirmMoveSession} disabled={!moveProjectInput.trim()}>移动</button>
            </div>
          </div>
        </div>
      )}


      {/* ============ 扩展管理 Modal ============ */}
      {showExtManager && <ExtensionManager onClose={() => setShowExtManager(false)} />}

      {/* ============ 日志查看器 Modal ============ */}
      {showLogViewer && (
        <div className="modal-overlay" onClick={() => setShowLogViewer(false)}>
          <div className="modal log-viewer" onClick={(e) => e.stopPropagation()}>
            <div className="log-header">
              <div className="modal-title">调试日志</div>
              <span className="log-count">共 {logs.length} 条{stderrCount > 0 && ` · stderr ${stderrCount}`}</span>
            </div>
            <div className="log-toolbar">
              <input
                className="log-search-input"
                type="text"
                placeholder="搜索日志内容…"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
              />
              <div className="log-filter-group">
                <button className={logFilter === "all" ? "active" : ""} onClick={() => setLogFilter("all")}>全部</button>
                <button className={logFilter === "stderr" ? "active" : ""} onClick={() => setLogFilter("stderr")}>stderr</button>
                <button className={logFilter === "event" ? "active" : ""} onClick={() => setLogFilter("event")}>事件</button>
              </div>
              <button className="btn-secondary log-clear-btn" onClick={() => setLogs([])} title="清空所有日志">清空</button>
            </div>
            <div
              className="log-list"
              ref={logListRef}
              onScroll={() => {
                const el = logListRef.current; if (!el) return;
                logAutoFollow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              }}
            >
              {filteredLogs.length === 0 ? (
                <div className="log-empty">{logs.length === 0 ? "暂无日志记录" : "无匹配日志"}</div>
              ) : filteredLogs.map((log, i) => (
                <div key={i} className={`log-entry ${log.type}`}>
                  <span className="log-time">{new Date(log.time).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                  <span className="log-type-tag">{log.type === "stderr" ? "ERR" : "EVT"}</span>
                  <span className="log-text">{log.text}</span>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => { setLogs([]); }}>清空</button>
              <button className="btn-primary" onClick={() => setShowLogViewer(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* ============ 设置面板 Modal ============ */}
      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal settings-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
            <div className="modal-title">设置</div>

            {/* 工作目录：pi 子进程的 cwd，输入输出文件都在这里 */}
            <div className="settings-section">
              <div className="settings-section-title">工作目录</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  type="text"
                  className="model-config-input"
                  style={{ flex: 1, minWidth: 240 }}
                  value={workdir}
                  onChange={(e) => setWorkdir(e.target.value)}
                  placeholder="例如 /Users/you/logistic-data（留空=沿用默认）"
                />
                <button type="button" className="btn-secondary" onClick={pickWorkdir}>浏览…</button>
                <button type="button" className="btn-primary" onClick={() => applyWorkdir(workdir)}>应用并重启 Pi</button>
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: "var(--fg-muted)" }}>
                设定后，pi 的工作目录固定为此处。新建会话的输入输出文件、文件浏览器默认定位都基于此目录，方便查找。切换会重启 pi 进程。
              </div>
            </div>

            {/* 扩展与技能管理（从侧栏顶部下沉到设置，减少首屏干扰）*/}
            <div className="settings-section">
              <div className="settings-section-title">扩展与技能</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button type="button" className="btn-primary" onClick={() => { setShowSettings(false); setShowExtManager(true); }}>管理扩展和技能</button>
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: "var(--fg-muted)" }}>
                管理 Pi 加载的扩展工具和技能（物流工具、单据生成器等）。
              </div>
            </div>

            {/* 模型配置（含 API Key 管理）*/}
            <div className="settings-section">
              <div className="settings-section-title" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>模型配置</span>
                {modelsConfigDirty && (
                  <span style={{ color: "var(--warning)", fontSize: 11, fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>
                    有未保存改动
                  </span>
                )}
              </div>
              {!modelsConfig ? (
                <div style={{ padding: "var(--space-4) 0", textAlign: "center", color: "var(--fg-muted)", fontSize: 13 }}>
                  加载中…
                </div>
              ) : (
                <>
                  <div className="model-config-list">
                    {Object.entries(modelsConfig.providers).map(([providerId, provider]) => {
                      const enabled = !!provider.apiKey && provider.models.length > 0;
                      const displayName = providerId === "siliconflow" ? "硅基流动"
                        : providerId === "custom" ? "自定义地址"
                        : providerId.charAt(0).toUpperCase() + providerId.slice(1);
                      const apiKeyIsEnv = provider.apiKey.startsWith("$");
                      return (
                      <div
                        key={providerId}
                        className={`model-provider-card ${enabled ? "enabled" : ""} ${editingProvider === providerId ? "editing" : ""}`}
                      >
                        <div
                          className="model-provider-head"
                          onClick={() => setEditingProvider(editingProvider === providerId ? null : providerId)}
                        >
                          <div className="model-provider-left">
                            <span className="model-provider-name">{displayName}</span>
                            {enabled && (
                              <span className="model-provider-status ok">已配置</span>
                            )}
                            {!enabled && (
                              <span className="model-provider-status missing">未配置</span>
                            )}
                          </div>
                          <span className="model-provider-chevron">
                            {editingProvider === providerId ? "▴" : "▾"}
                          </span>
                        </div>
                        {editingProvider === providerId && (
                          <div className="model-provider-body">
                            <div className="model-config-field">
                              <label className="model-config-label">API Key</label>
                              <input
                                type="password"
                                className="model-config-input"
                                value={provider.apiKey}
                                placeholder={`输入 ${displayName} API Key，可填 $ENV_VAR 引用环境变量`}
                                onChange={(e) => updateProvider(providerId, { apiKey: e.target.value })}
                              />
                              <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>可填 $ENV_VAR 引用环境变量，或直接填明文 key</span>
                            </div>
                            <div className="model-config-field">
                              <label className="model-config-label">Base URL</label>
                              <input
                                type="text"
                                className="model-config-input"
                                value={provider.baseUrl || ""}
                                placeholder="自定义 API 地址"
                                onChange={(e) => updateProvider(providerId, { baseUrl: e.target.value })}
                              />
                            </div>
                            <div className="model-config-field">
                              <label className="model-config-label">可用模型（每行一个模型 id）</label>
                              <textarea
                                className="model-config-textarea"
                                value={provider.models.map((m) => m.id).join("\n")}
                                rows={4}
                                placeholder={"每行输入一个模型 id\n例如：\ndeepseek-ai/DeepSeek-V4-Flash\nPro/deepseek-ai/DeepSeek-V3.1\nQwen/Qwen3-30B-A3B"}
                                onChange={(e) => updateProvider(providerId, { models: e.target.value.split("\n").map((s) => s.trim()).filter((s) => s).map((id) => ({ id, name: id })) })}
                              />
                            </div>
                            <div className="model-config-field" style={{ flexDirection: "row", alignItems: "center", gap: "var(--space-2)" }}>
                              <button
                                className="btn-secondary"
                                disabled={connTest[providerId]?.status === "testing" || !provider.apiKey || apiKeyIsEnv}
                                onClick={async () => {
                                  setConnTest((prev) => ({ ...prev, [providerId]: { status: "testing" } }));
                                  try {
                                    const result = await invoke<any>("test_model_connection", {
                                      providerId: providerId,
                                      apiKey: provider.apiKey,
                                      baseUrl: provider.baseUrl || null,
                                      model: provider.models[0]?.id || null,
                                    });
                                    if (result.success) {
                                      setConnTest((prev) => ({ ...prev, [providerId]: { status: "ok", message: result.message, model: result.model } }));
                                    } else {
                                      const hint = result.hint ? `（${result.hint}）` : "";
                                      setConnTest((prev) => ({ ...prev, [providerId]: { status: "fail", message: `${result.message}${hint}` } }));
                                    }
                                  } catch (e: any) {
                                    setConnTest((prev) => ({ ...prev, [providerId]: { status: "fail", message: String(e) } }));
                                  }
                                }}
                              >
                                {connTest[providerId]?.status === "testing" ? "测试中…" : "测试连接"}
                              </button>
                              {apiKeyIsEnv && (
                                <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>
                                  API Key 引用了环境变量，无法在此测试，请保存后通过实际使用验证
                                </span>
                              )}
                              {connTest[providerId]?.status === "ok" && (
                                <span style={{ color: "var(--success, #16a34a)", fontSize: 12 }}>
                                  ✓ {connTest[providerId].message}
                                  {connTest[providerId].model && <span style={{ color: "var(--fg-muted)" }}> (模型: {connTest[providerId].model})</span>}
                                </span>
                              )}
                              {connTest[providerId]?.status === "fail" && (
                                <span style={{ color: "var(--error, #dc2626)", fontSize: 12, wordBreak: "break-all" }}>
                                  ✗ {connTest[providerId].message}
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                      );
                    })}
                  </div>
                  <div className="model-config-actions">
                    <button
                      className="btn-primary"
                      onClick={saveModelsConfig}
                      disabled={modelsConfigSaving || !modelsConfigDirty}
                    >
                      {modelsConfigSaving ? "保存中…" : "保存模型配置"}
                    </button>
                    <span className="model-config-hint">
                      配置文件：~/.pi/agent/models.json（Pi 原生格式）。API Key 可填 $ENV_VAR 引用环境变量，或直接填明文。
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* 主题 */}
            <div className="settings-section">
              <div className="settings-section-title">外观</div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">主题</div>
                  <div className="setting-desc">深色 / 浅色 / 跟随系统</div>
                </div>
                <div className="setting-control">
                  <div className="theme-switch">
                    <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>深色</button>
                    <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>浅色</button>
                    <button className={theme === "system" ? "active" : ""} onClick={() => setTheme("system")}>系统</button>
                  </div>
                </div>
              </div>
            </div>

            {/* 思维链 */}
            <div className="settings-section">
              <div className="settings-section-title">推理</div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">思维链强度</div>
                  <div className="setting-desc">越高推理越深，但更慢更费 token</div>
                </div>
                <select
                  className="setting-select"
                  value={thinkingLevel}
                  onChange={(e) => setThinking(e.target.value)}
                >
                  <option value="off">关闭</option>
                  <option value="minimal">极简</option>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                  <option value="xhigh">极高</option>
                </select>
              </div>
            </div>

            {/* 上下文管理 */}
            <div className="settings-section">
              <div className="settings-section-title">上下文管理</div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">自动压缩</div>
                  <div className="setting-desc">上下文将满时自动压缩会话</div>
                </div>
                <div className={`toggle ${autoCompaction ? "on" : ""}`} onClick={() => toggleAutoCompaction(!autoCompaction)} />
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">手动压缩</div>
                  <div className="setting-desc">立即压缩当前会话</div>
                </div>
                <button className="btn-primary" onClick={compactNow} disabled={busy}>压缩</button>
              </div>
            </div>

            {/* 错误处理 */}
            <div className="settings-section">
              <div className="settings-section-title">错误处理</div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">自动重试</div>
                  <div className="setting-desc">瞬时错误（限流/5xx）自动重试</div>
                </div>
                <div className={`toggle ${autoRetry ? "on" : ""}`} onClick={() => toggleAutoRetry(!autoRetry)} />
              </div>
            </div>

            {/* 工具权限 */}
            <div className="settings-section">
              <div className="settings-section-title">工具权限模式</div>
              <div className="setting-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: "var(--space-2)" }}>
                <div>
                  <div className="setting-label">权限模式</div>
                  <div className="setting-desc">控制 AI 助手调用工具时的确认行为，减少不必要的权限弹窗。</div>
                </div>
                <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                  <button
                    className={`btn-primary ${permissionMode === "cautious" ? "" : "btn-secondary"}`}
                    style={{ opacity: permissionMode === "cautious" ? 1 : 0.6 }}
                    onClick={() => setPermissionModePersist("cautious")}
                  >审慎模式</button>
                  <button
                    className={`btn-primary ${permissionMode === "workspace" ? "" : "btn-secondary"}`}
                    style={{ opacity: permissionMode === "workspace" ? 1 : 0.6 }}
                    onClick={() => setPermissionModePersist("workspace")}
                  >工作台模式</button>
                  <button
                    className={`btn-primary ${permissionMode === "trust" ? "" : "btn-secondary"}`}
                    style={{ opacity: permissionMode === "trust" ? 1 : 0.6 }}
                    onClick={() => setPermissionModePersist("trust")}
                  >全信任模式</button>
                </div>
                <div className="setting-desc" style={{ fontSize: "0.85em" }}>
                  {permissionMode === "cautious" && "✓ 审慎模式：生成文件前确认，删除/外部请求必须确认。最安全，弹窗较多。"}
                  {permissionMode === "workspace" && "✓ 工作台模式：本地生成和分析自动执行，除了删除等重要修改外都自动放行。推荐。"}
                  {permissionMode === "trust" && "✓ 全信任模式：所有已授权工具自动执行，零打断。最快但有风险。"}
                </div>
              </div>
            </div>

            {/* 系统提示词编辑器 */}
            <div className="settings-section">
              <div className="settings-section-title">Agent 人设 / 系统提示词</div>
              <div className="setting-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: "var(--space-2)" }}>
                <div>
                  <div className="setting-label">提示词文件</div>
                  <div className="setting-desc">{systemPromptPathHint}</div>
                  <div className="setting-desc" style={{ marginTop: 4, color: "var(--fg-subtle)" }}>保存后会自动重启 Pi 让新提示词立即生效。</div>
                </div>
                <div style={{ display: "flex", gap: "var(--space-2)", width: "100%" }}>
                  <select
                    className="setting-select"
                    style={{ flex: "0 0 auto" }}
                    value={systemPromptPath}
                    onChange={(e) => { setSystemPromptPath(e.target.value); loadSystemPrompt(e.target.value); }}
                  >
                    <option value="SYSTEM.md">SYSTEM.md（替换默认）</option>
                    <option value="APPEND_SYSTEM.md">APPEND_SYSTEM.md（追加）</option>
                    <option value="AGENTS.md">AGENTS.md（上下文文件）</option>
                  </select>
                  <button
                    className="btn-primary"
                    onClick={saveSystemPrompt}
                    disabled={systemPromptSaving || !systemPromptDirty}
                    style={{ flex: "0 0 auto" }}
                  >
                    {systemPromptSaving ? "保存中…" : "保存"}
                  </button>
                </div>
                <textarea
                  className="setting-textarea"
                  value={systemPrompt}
                  onChange={(e) => { setSystemPrompt(e.target.value); setSystemPromptDirty(true); }}
                  placeholder={"在此编写 agent 的系统提示词 / 人设。\n例如：你是 HT 物流公司的智能助理，专注于物流单据处理、运输调度、库存查询…"}
                  rows={12}
                  style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 12, resize: "vertical" }}
                />
                <div className="setting-desc">
                  保存后<strong>新建会话</strong>即生效；当前会话不会热重载。
                  {systemPromptDirty && <span style={{ color: "var(--warning)" }}> · 有未保存改动</span>}
                </div>
              </div>
            </div>

            {/* 关于与更新（手动检查模式，后续再加启动时自动检查）*/}
            <div className="settings-section">
              <div className="settings-section-title">关于与更新</div>
              <div className="setting-row" style={{ alignItems: "flex-start", flexDirection: "column", gap: "var(--space-2)" }}>
                <div>
                  <div className="setting-label">当前版本</div>
                  <div className="setting-desc">v{appVersion || "—"}</div>
                </div>

                {updateStatus.kind === "idle" && (
                  <button className="btn-secondary" onClick={doCheckUpdate}>检查更新</button>
                )}

                {updateStatus.kind === "checking" && (
                  <button className="btn-secondary" disabled>检查中…</button>
                )}

                {updateStatus.kind === "up-to-date" && (
                  <div className="setting-desc" style={{ color: "var(--success, #16a34a)" }}>
                    ✓ 已是最新版本 (v{updateStatus.currentVersion})
                    <div style={{ marginTop: 6 }}>
                      <button className="btn-secondary" onClick={doCheckUpdate}>再次检查</button>
                    </div>
                  </div>
                )}

                {updateStatus.kind === "available" && (
                  <div style={{ width: "100%" }}>
                    <div className="setting-label" style={{ color: "var(--success, #16a34a)" }}>
                      发现新版本：v{updateStatus.version}
                    </div>
                    <div className="setting-desc" style={{ marginTop: 4, whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto" }}>
                      {updateStatus.notes}
                    </div>
                    <div style={{ display: "flex", gap: "var(--space-2)", marginTop: 8 }}>
                      <button className="btn-primary" onClick={doDownloadAndInstall}>下载并安装</button>
                      <button className="btn-secondary" onClick={doCheckUpdate}>重新检查</button>
                    </div>
                  </div>
                )}

                {updateStatus.kind === "downloading" && (
                  <div style={{ width: "100%" }}>
                    <div className="setting-label">正在下载… {updateStatus.percent}%</div>
                    <div style={{
                      width: "100%", height: 6, background: "var(--bg-hover, #e5e7eb)",
                      borderRadius: 3, marginTop: 6, overflow: "hidden"
                    }}>
                      <div style={{
                        width: `${updateStatus.percent}%`, height: "100%",
                        background: "var(--accent, #2563eb)", transition: "width 0.2s"
                      }} />
                    </div>
                  </div>
                )}

                {updateStatus.kind === "done" && (
                  <div className="setting-desc" style={{ color: "var(--success, #16a34a)" }}>
                    ✓ 下载完成，即将重启…
                  </div>
                )}

                {updateStatus.kind === "error" && (
                  <div>
                    <div className="setting-desc" style={{ color: "var(--error, #dc2626)" }}>
                      ✗ 检查更新失败：{updateStatus.message}
                    </div>
                    <div style={{ display: "flex", gap: "var(--space-2)", marginTop: 6, flexWrap: "wrap" }}>
                      <button className="btn-secondary" onClick={doCheckUpdate}>重试</button>
                      <button className="btn-secondary" onClick={async () => {
                        try {
                          const msg = await invoke("open_update_folder");
                          console.log(msg);
                        } catch (e) {
                          console.error("打开更新文件夹失败:", e);
                        }
                      }}>打开更新文件夹</button>
                    </div>
                    <div className="setting-desc" style={{ color: "var(--fg-subtle)", marginTop: 4, fontSize: 12 }}>
                      如果下载已完成但安装失败，可在更新文件夹中找到安装包手动运行。
                    </div>
                  </div>
                )}

                <div className="setting-desc" style={{ color: "var(--fg-subtle)", marginTop: 4 }}>
                  更新源：GitHub Release。仅手动检查，不会自动下载或安装。
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn-primary" onClick={() => setShowSettings(false)}>完成</button>
            </div>
          </div>
        </div>
      )}

      {/* ============ Extension UI Modal ============ */}
      {uiRequest && (
        <div className="modal-overlay" onClick={(e) => e.stopPropagation()}>
          <div className="modal">
            <div className="modal-title">{uiRequest.ev.title || "Pi 需要你的输入"}</div>
            {uiRequest.ev.message && <div className="modal-message">{uiRequest.ev.message}</div>}
            {uiRequest.ev.method === "confirm" && (
              <div className="modal-actions">
                <button className="btn-secondary" onClick={() => respondUiRequest({ confirmed: false, cancelled: false })}>取消</button>
                <button className="btn-primary" onClick={() => respondUiRequest({ confirmed: true, cancelled: false })}>确认</button>
              </div>
            )}
            {uiRequest.ev.method === "select" && uiRequest.ev.options && (
              <>
                <div className="modal-options">
                  {uiRequest.ev.options.map((opt: string, i: number) => (
                    <label key={i} className={`modal-option ${uiRequest.selectIndex === i ? "active" : ""}`}>
                      <input type="radio" name="modal-select" checked={uiRequest.selectIndex === i}
                        onChange={() => setUiRequest((r: any) => r ? { ...r, selectIndex: i } : null)} />
                      <span>{opt}</span>
                    </label>
                  ))}
                </div>
                <div className="modal-actions">
                  <button className="btn-secondary" onClick={() => respondUiRequest({ cancelled: true })}>取消</button>
                  <button className="btn-primary" onClick={() => respondUiRequest({ value: uiRequest.ev.options[uiRequest.selectIndex] })}>确定</button>
                </div>
              </>
            )}
            {(uiRequest.ev.method === "input" || (uiRequest.ev.method !== "confirm" && uiRequest.ev.method !== "select")) && (
              <>
                <input type="text" className="modal-input" value={uiRequest.inputValue}
                  onChange={(e) => setUiRequest((r: any) => r ? { ...r, inputValue: e.target.value } : null)}
                  onKeyDown={(e) => { if (e.key === "Enter") respondUiRequest({ value: uiRequest.inputValue }); }}
                  autoFocus />
                <div className="modal-actions">
                  <button className="btn-secondary" onClick={() => respondUiRequest({ cancelled: true })}>取消</button>
                  <button className="btn-primary" onClick={() => respondUiRequest({ value: uiRequest.inputValue })}>确定</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============ 工具卡片组件 ============
function ToolCard({ tool, onToggle }: { tool: ToolCall; onToggle: () => void }) {
  const summary = formatToolSummary(tool.name, tool.args);
  return (
    <div className={`tool-card ${tool.status} ${tool.expanded ? "expanded" : ""}`}>
      <div className="tool-head" onClick={onToggle}>
        <span className={`tool-status-dot ${tool.status}`} />
        <span className="tool-name">{tool.name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        <span className="tool-chevron">{tool.expanded ? "▾" : "▸"}</span>
      </div>
      {tool.expanded && (
        <div className="tool-body">
          <div className="tool-section-label">参数</div>
          <pre className="tool-pre">{JSON.stringify(tool.args, null, 2)}</pre>
          {tool.result && (
            <>
              <div className="tool-section-label">结果</div>
              {(() => {
                // chart_render 工具的 details.chartConfig 用 Chart.js 渲染
                const chartCfg = extractChartConfig(tool.result);
                if (chartCfg && tool.name === "chart_render") {
                  return <ChartView config={chartCfg} />;
                }
                return <pre className="tool-pre">{formatToolResult(tool.result)}</pre>;
              })()}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ============ 工具函数 ============
function formatToolSummary(name: string, args: any): string {
  if (!args) return "";
  switch (name) {
    case "query_database": return args.sql ? args.sql.slice(0, 60).replace(/\s+/g, " ") : "";
    case "task_create": return args.title || "";
    case "task_list": return args.status ? `status=${args.status}` : "全部";
    case "task_update": return `#${args.id} → ${args.status || args.priority || ""}`;
    case "note_upsert": return args.title || "";
    case "note_search": return args.keyword || "";
    case "http_request": return `${args.method || "GET"} ${args.url || ""}`;
    case "run_script": return args.script || "";
    case "parse_pdf": return args.path || "";
    case "vector_search": return args.query || "";
    default: return JSON.stringify(args).slice(0, 60);
  }
}

function formatToolResult(result: any): string {
  if (!result) return "";
  if (result.content && Array.isArray(result.content)) {
    const text = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    const details = result.details ? `\n\n[details]\n${JSON.stringify(result.details, null, 2)}` : "";
    return text + details;
  }
  return JSON.stringify(result, null, 2);
}

// rebuildTurnsFromMessages / extractTextFromContent 已抽出到 ./utils.ts（便于单元测试）
