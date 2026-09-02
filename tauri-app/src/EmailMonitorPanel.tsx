import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  Eye,
  EyeOff,
  Inbox,
  KeyRound,
  LoaderCircle,
  Mail,
  RefreshCw,
  Save,
  Search,
  Send,
  ShieldCheck,
  Trash2,
} from "lucide-react";

interface EmailAccount {
  email: string;
  host: string;
  port: number;
  mailbox: string;
}

interface EmailConnection {
  email: string;
  configured: boolean;
}

interface MonitorMessage {
  account: string;
  uid: number;
  receivedAt: string;
  from: string;
  to: string;
  subject: string;
  reference: string;
  tracking: string;
  status: "待处理" | "待确认" | "观察中" | "已完成";
  attention: boolean;
  reason: string;
  summary: string;
  action: string;
  deadline: string;
}

interface AccountScanResult {
  email: string;
  status: "ok" | "error";
  error?: string;
  lastUid: number;
  scannedUids: number[];
}

interface ScanResponse {
  status: string;
  accounts: AccountScanResult[];
  messages: MonitorMessage[];
}

interface MonitorSettings {
  enabled: boolean;
  intervalMinutes: number;
  keywords: string;
}

interface MonitorStore {
  messages: MonitorMessage[];
  knownUids: Record<string, number[]>;
  lastUids: Record<string, number>;
  lastChecked: number | null;
}

interface EmailMonitorPanelProps {
  active: boolean;
  onSendToAssistant: (message: string) => void;
  onAttentionCount: (count: number) => void;
}

const SETTINGS_KEY = "ht-email-monitor-settings-v1";
const STORE_KEY = "ht-email-monitor-store-v1";
const ACCOUNTS: EmailAccount[] = [
  { email: "cs.logistics@hotbeautyhair.com", host: "imap.exmail.qq.com", port: 993, mailbox: "INBOX" },
  { email: "logistics@hotbeautyhair.com", host: "imap.exmail.qq.com", port: 993, mailbox: "INBOX" },
];

function loadSettings(): MonitorSettings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (value && typeof value === "object") {
      return {
        enabled: Boolean(value.enabled),
        intervalMinutes: Number(value.intervalMinutes) || 180,
        keywords: typeof value.keywords === "string" ? value.keywords : "dhl",
      };
    }
  } catch { /* ignore invalid local settings */ }
  return { enabled: false, intervalMinutes: 180, keywords: "dhl" };
}

function loadStore(): MonitorStore {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (value && typeof value === "object") {
      return {
        messages: Array.isArray(value.messages) ? value.messages : [],
        knownUids: value.knownUids && typeof value.knownUids === "object" ? value.knownUids : {},
        lastUids: value.lastUids && typeof value.lastUids === "object" ? value.lastUids : {},
        lastChecked: typeof value.lastChecked === "number" ? value.lastChecked : null,
      };
    }
  } catch { /* ignore invalid local state */ }
  return { messages: [], knownUids: {}, lastUids: {}, lastChecked: null };
}

function messageKey(message: MonitorMessage): string {
  return `${message.account}:${message.uid}`;
}

function formatTime(value: string): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function statusClass(status: MonitorMessage["status"]): string {
  if (status === "待处理") return "urgent";
  if (status === "观察中") return "watching";
  if (status === "已完成") return "completed";
  return "confirm";
}

export function EmailMonitorPanel({ active, onSendToAssistant, onAttentionCount }: EmailMonitorPanelProps) {
  const [settings, setSettings] = useState<MonitorSettings>(loadSettings);
  const [store, setStore] = useState<MonitorStore>(loadStore);
  const [connections, setConnections] = useState<Record<string, boolean>>({});
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});
  const [editingAccount, setEditingAccount] = useState<string | null>(null);
  const [scanErrors, setScanErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<"scan" | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"attention" | "all">("attention");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const scanRef = useRef<() => Promise<void>>(async () => {});
  const autoStartedRef = useRef(false);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }, [store]);

  useEffect(() => {
    const emails = ACCOUNTS.map((account) => account.email);
    invoke<{ connections: EmailConnection[] }>("get_email_connections", { emails })
      .then((result) => setConnections(Object.fromEntries(result.connections.map((item) => [item.email, item.configured]))))
      .catch(() => setConnections(Object.fromEntries(emails.map((email) => [email, false]))));
  }, []);

  const attentionCount = useMemo(
    () => store.messages.filter((message) => message.attention && message.status !== "已完成").length,
    [store.messages],
  );

  useEffect(() => onAttentionCount(attentionCount), [attentionCount, onAttentionCount]);

  const saveCredentials = useCallback(async (email: string) => {
    const password = passwords[email] || "";
    if (!password.trim()) {
      setError("请输入腾讯企业邮箱的客户端专用密码");
      return;
    }
    setLoading(email);
    setError(null);
    try {
      await invoke("save_email_credentials", { email, password });
      setConnections((current) => ({ ...current, [email]: true }));
      setPasswords((current) => ({ ...current, [email]: "" }));
      setEditingAccount(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(null);
    }
  }, [passwords]);

  const clearCredentials = useCallback(async (email: string) => {
    try { await invoke("clear_email_credentials", { email }); } catch { /* best effort */ }
    setConnections((current) => ({ ...current, [email]: false }));
    setEditingAccount(email);
  }, []);

  const scan = useCallback(async () => {
    const configuredAccounts = ACCOUNTS.filter((account) => connections[account.email]);
    if (!configuredAccounts.length) {
      setError("请先为至少一个邮箱配置客户端专用密码");
      return;
    }
    const keywords = settings.keywords.split(/[，,\s]+/).map((value) => value.trim()).filter(Boolean);
    setLoading("scan");
    setError(null);
    try {
      const accounts = configuredAccounts.map((account) => ({
        ...account,
        keywords,
        knownUids: store.knownUids[account.email] || [],
        lastUid: store.lastUids[account.email] || 0,
      }));
      const result = await invoke<ScanResponse>("email_monitor_scan", { accounts });
      const nextErrors: Record<string, string> = {};
      result.accounts.forEach((account) => {
        if (account.status === "error" && account.error) nextErrors[account.email] = account.error;
      });
      setScanErrors(nextErrors);
      setStore((current) => {
        const merged = new Map(current.messages.map((message) => [messageKey(message), message]));
        result.messages.forEach((message) => merged.set(messageKey(message), message));
        const knownUids = { ...current.knownUids };
        const lastUids = { ...current.lastUids };
        result.accounts.forEach((account) => {
          const uids = new Set([...(knownUids[account.email] || []), ...account.scannedUids]);
          knownUids[account.email] = Array.from(uids).sort((a, b) => b - a).slice(0, 1000);
          if (account.status === "ok") lastUids[account.email] = account.lastUid;
        });
        return {
          messages: Array.from(merged.values())
            .sort((a, b) => (b.receivedAt || "").localeCompare(a.receivedAt || ""))
            .slice(0, 300),
          knownUids,
          lastUids,
          lastChecked: Date.now(),
        };
      });
      const firstAttention = result.messages.find((message) => message.attention);
      if (firstAttention) setSelectedKey(messageKey(firstAttention));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(null);
    }
  }, [connections, settings.keywords, store.knownUids, store.lastUids]);

  useEffect(() => { scanRef.current = scan; }, [scan]);

  useEffect(() => {
    if (!settings.enabled) {
      autoStartedRef.current = false;
      return;
    }
    if (!autoStartedRef.current && Object.values(connections).some(Boolean)) {
      autoStartedRef.current = true;
      void scanRef.current();
    }
    const timer = window.setInterval(() => scanRef.current(), settings.intervalMinutes * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [connections, settings.enabled, settings.intervalMinutes]);

  const visibleMessages = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return store.messages.filter((message) => {
      if (tab === "attention" && (!message.attention || message.status === "已完成")) return false;
      if (!keyword) return true;
      return [message.subject, message.from, message.reference, message.tracking, message.summary]
        .some((value) => String(value || "").toLowerCase().includes(keyword));
    });
  }, [search, store.messages, tab]);

  useEffect(() => {
    if (!selectedKey || !visibleMessages.some((message) => messageKey(message) === selectedKey)) {
      setSelectedKey(visibleMessages[0] ? messageKey(visibleMessages[0]) : null);
    }
  }, [selectedKey, visibleMessages]);

  const selected = store.messages.find((message) => messageKey(message) === selectedKey) || null;

  const markCompleted = useCallback((message: MonitorMessage) => {
    setStore((current) => ({
      ...current,
      messages: current.messages.map((item) => messageKey(item) === messageKey(message)
        ? { ...item, status: "已完成", attention: false }
        : item),
    }));
  }, []);

  const sendToAssistant = useCallback((message: MonitorMessage) => {
    onSendToAssistant([
      "请分析这封 DHL 物流邮件，核对系统判断是否准确，并给出下一步行动；如需回复，请同时起草一封简洁、专业的邮件。",
      `邮箱：${message.account}`,
      `收到时间：${message.receivedAt || "未知"}`,
      `发件人：${message.from}`,
      `主题：${message.subject}`,
      `参考号：${message.reference || "未识别"}`,
      `运单号：${message.tracking || "未识别"}`,
      `当前判断：${message.status}；${message.reason}`,
      `邮件摘要：${message.summary}`,
      `建议行动：${message.action}`,
      `截止时间：${message.deadline || "未识别"}`,
    ].join("\n\n"));
  }, [onSendToAssistant]);

  return (
    <>
      <aside className={`email-monitor-sidebar ${active ? "active" : ""}`} aria-label="邮件监控设置">
        <header className="email-monitor-side-heading">
          <span><Mail size={18} /></span>
          <div><strong>邮件监控</strong><small>只读检查 · 不改变已读状态</small></div>
        </header>

        <section className={`email-monitor-switch ${settings.enabled ? "enabled" : ""}`}>
          <div><strong>{settings.enabled ? "自动监控已开启" : "自动监控未开启"}</strong><small>应用打开期间按计划检查</small></div>
          <button type="button" role="switch" aria-checked={settings.enabled} onClick={() => setSettings((current) => ({ ...current, enabled: !current.enabled }))}><i /></button>
        </section>

        <div className="email-monitor-side-label">监控邮箱</div>
        <div className="email-account-list">
          {ACCOUNTS.map((account) => {
            const configured = Boolean(connections[account.email]);
            const editing = editingAccount === account.email || !configured;
            return (
              <section className="email-account" key={account.email}>
                <header>
                  <span className={configured ? "connected" : ""}>{configured ? <ShieldCheck size={15} /> : <KeyRound size={15} />}</span>
                  <div><strong>{account.email}</strong><small>{configured ? "凭据已安全保存" : "等待配置客户端密码"}</small></div>
                  {configured && <button type="button" title="重新配置" onClick={() => setEditingAccount(editing ? null : account.email)}>•••</button>}
                </header>
                {editing && (
                  <div className="email-account-secret">
                    <div>
                      <input
                        type={showPasswords[account.email] ? "text" : "password"}
                        value={passwords[account.email] || ""}
                        onChange={(event) => setPasswords((current) => ({ ...current, [account.email]: event.target.value }))}
                        placeholder="客户端专用密码"
                      />
                      <button type="button" title={showPasswords[account.email] ? "隐藏密码" : "显示密码"} onClick={() => setShowPasswords((current) => ({ ...current, [account.email]: !current[account.email] }))}>
                        {showPasswords[account.email] ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                    <span>
                      {configured && <button className="email-monitor-text danger" type="button" onClick={() => clearCredentials(account.email)}><Trash2 size={13} />清除</button>}
                      <button className="email-monitor-save" type="button" onClick={() => saveCredentials(account.email)} disabled={loading === account.email}>
                        {loading === account.email ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />}保存
                      </button>
                    </span>
                  </div>
                )}
                {scanErrors[account.email] && <p className="email-account-error">{scanErrors[account.email]}</p>}
              </section>
            );
          })}
        </div>

        <div className="email-monitor-side-label">检查规则</div>
        <section className="email-monitor-settings">
          <label><span>关键词</span><input value={settings.keywords} onChange={(event) => setSettings((current) => ({ ...current, keywords: event.target.value }))} /></label>
          <label><span>检查间隔</span><select value={settings.intervalMinutes} onChange={(event) => setSettings((current) => ({ ...current, intervalMinutes: Number(event.target.value) }))}>
            <option value={30}>每 30 分钟</option>
            <option value={60}>每 1 小时</option>
            <option value={180}>每 3 小时</option>
            <option value={360}>每 6 小时</option>
          </select></label>
        </section>

        <div className="email-monitor-side-spacer" />
        <div className="email-monitor-privacy"><Eye size={14} /><span>只读取匹配邮件，不下载附件，不回复、不删除，也不改变已读状态。</span></div>
      </aside>

      <section className={`email-monitor-page ${active ? "active" : ""}`}>
        <header className="email-monitor-header">
          <div>
            <span>业务中心 / 邮件监控</span>
            <h1>重点邮件</h1>
            <p>{store.lastChecked ? `上次检查 ${new Date(store.lastChecked).toLocaleString("zh-CN")}` : "尚未执行检查"}</p>
          </div>
          <div>
            <span className="email-monitor-count"><b>{attentionCount}</b> 待关注</span>
            <button type="button" onClick={scan} disabled={loading === "scan"}>
              {loading === "scan" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}立即检查
            </button>
          </div>
        </header>

        {error && <div className="email-monitor-error"><AlertTriangle size={16} /><span>{error}</span><button type="button" onClick={() => setError(null)}>×</button></div>}

        <div className="email-monitor-toolbar">
          <div className="email-monitor-tabs">
            <button className={tab === "attention" ? "active" : ""} type="button" onClick={() => setTab("attention")}>待关注 <span>{attentionCount}</span></button>
            <button className={tab === "all" ? "active" : ""} type="button" onClick={() => setTab("all")}>全部邮件 <span>{store.messages.length}</span></button>
          </div>
          <label><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索主题、运单号或参考号" /></label>
        </div>

        <div className="email-monitor-content">
          <div className="email-monitor-list" aria-label="邮件列表">
            {visibleMessages.length ? visibleMessages.map((message) => (
              <button key={messageKey(message)} className={messageKey(message) === selectedKey ? "active" : ""} type="button" onClick={() => setSelectedKey(messageKey(message))}>
                <span className={`email-status-dot ${statusClass(message.status)}`} />
                <span className="email-list-copy">
                  <span><strong>{message.subject}</strong><time>{formatTime(message.receivedAt)}</time></span>
                  <small>{message.from}</small>
                  <em>{message.reason}</em>
                  <span className="email-list-meta">
                    <i className={statusClass(message.status)}>{message.status}</i>
                    {message.tracking && <b>运单 {message.tracking}</b>}
                    {message.deadline && <b><Clock3 size={11} />{message.deadline}</b>}
                  </span>
                </span>
              </button>
            )) : (
              <div className="email-monitor-empty-list"><Inbox size={24} /><strong>{tab === "attention" ? "没有待关注邮件" : "还没有监控记录"}</strong><span>配置邮箱后点击“立即检查”</span></div>
            )}
          </div>

          <article className="email-monitor-detail">
            {selected ? (
              <>
                <header>
                  <div><span className={`email-status-badge ${statusClass(selected.status)}`}>{selected.status}</span><small>UID {selected.uid}</small></div>
                  <h2>{selected.subject}</h2>
                  <p>{selected.from}<span>→</span>{selected.account}</p>
                  <time>{formatTime(selected.receivedAt)}</time>
                </header>
                {(selected.reference || selected.tracking || selected.deadline) && <div className="email-detail-facts">
                  {selected.reference && <span><small>参考号</small><strong>{selected.reference}</strong></span>}
                  {selected.tracking && <span><small>运单号</small><strong>{selected.tracking}</strong></span>}
                  {selected.deadline && <span><small>截止时间</small><strong>{selected.deadline}</strong></span>}
                </div>}
                <section><h3>关注原因</h3><p>{selected.reason}</p></section>
                <section><h3>邮件摘要</h3><p>{selected.summary || "没有可读取的正文内容。"}</p></section>
                <section><h3>建议行动</h3><p>{selected.action}</p></section>
                <footer>
                  {selected.status !== "已完成" && <button className="email-detail-complete" type="button" onClick={() => markCompleted(selected)}><Check size={15} />标记完成</button>}
                  <button className="email-detail-ai" type="button" onClick={() => sendToAssistant(selected)}><Send size={15} />交给 AI 处理</button>
                </footer>
              </>
            ) : (
              <div className="email-monitor-empty-detail"><CheckCircle2 size={30} /><strong>选择一封邮件查看详情</strong><span>系统判断只作为辅助，重要操作前请核对原邮件。</span></div>
            )}
          </article>
        </div>
      </section>
    </>
  );
}
