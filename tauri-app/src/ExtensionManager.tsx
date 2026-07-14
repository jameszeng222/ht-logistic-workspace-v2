import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Markdown } from "./Markdown";

interface InstalledExt {
  name: string;
  path: string;
  isDir: boolean;
  description: string;
  mtime: number;
  size: number;
}

interface PiCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  location?: string;
  path?: string;
}

export function ExtensionManager({ onClose }: { onClose: () => void }) {
  const [commands, setCommands] = useState<PiCommand[]>([]);
  const [installed, setInstalled] = useState<InstalledExt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewingPath, setViewingPath] = useState<string | null>(null);
  const [viewingContent, setViewingContent] = useState<string>("");
  const [viewingName, setViewingName] = useState("");
  const [installing, setInstalling] = useState(false);
  const [tab, setTab] = useState<"commands" | "installed">("commands");

  const loadCommands = useCallback(async () => {
    try {
      const data = await invoke<any>("send_request", { command: { type: "get_commands" } });
      const list = Array.isArray(data) ? data : (data?.commands || data?.list || []);
      setCommands(list.map((c: any) => ({
        name: c.name || c.command || c.id || String(c),
        description: c.description || c.desc || c.help,
        source: c.source || "extension",
        location: c.location,
        path: c.path,
      })));
    } catch (e) { setError(String(e)); }
  }, []);

  const loadInstalled = useCallback(async () => {
    try {
      const list = await invoke<InstalledExt[]>("list_extensions");
      setInstalled(list);
    } catch (e) {
      // 目录不存在等情况不算严重错误
      setInstalled([]);
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    await Promise.all([loadCommands(), loadInstalled()]);
    setLoading(false);
  }, [loadCommands, loadInstalled]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const viewFile = async (path: string, name: string) => {
    setViewingPath(path); setViewingName(name); setViewingContent("");
    try {
      const content = await invoke<string>("read_text_file", { path });
      setViewingContent(content);
    } catch (e) { setViewingContent(`读取失败：${e}`); }
  };

  const handleInstall = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: true,
        title: "选择扩展目录或文件",
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      setInstalling(true);
      await invoke("install_extension", { sourcePath: path });
      await loadAll();
    } catch (e) {
      setError(`安装失败：${e}`);
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = async (name: string) => {
    if (!confirm(`确定要卸载扩展「${name}」吗？此操作不可恢复。`)) return;
    try {
      await invoke("uninstall_extension", { name });
      await loadAll();
    } catch (e) {
      setError(`卸载失败：${e}`);
    }
  };

  const extensions = commands.filter((c) => c.source === "extension");
  const prompts = commands.filter((c) => c.source === "prompt");
  const skills = commands.filter((c) => c.source === "skill");

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal ext-mgr-modal" onClick={(e) => e.stopPropagation()}>
        {viewingPath ? (
          <>
            <div className="modal-title">
              <button className="icon-btn ext-back-btn" onClick={() => setViewingPath(null)}>← 返回</button>
              {viewingName}
            </div>
            <div className="ext-viewer">
              <Markdown content={viewingContent || "加载中…"} />
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setViewingPath(null)}>关闭</button>
            </div>
          </>
        ) : (
          <>
            <div className="modal-title">
              扩展管理
              <span className="ext-mgr-stats">
                {extensions.length} 命令 · {prompts.length} 模板 · {skills.length} Skill · {installed.length} 已安装
              </span>
            </div>

            <div className="ext-tabs">
              <button
                className={`ext-tab ${tab === "commands" ? "active" : ""}`}
                onClick={() => setTab("commands")}
              >
                已加载命令
              </button>
              <button
                className={`ext-tab ${tab === "installed" ? "active" : ""}`}
                onClick={() => setTab("installed")}
              >
                已安装扩展
              </button>
            </div>

            {tab === "installed" && (
              <div className="ext-install-bar">
                <button
                  className="btn-primary"
                  onClick={handleInstall}
                  disabled={installing}
                >
                  {installing ? "安装中…" : "+ 安装扩展"}
                </button>
                <span className="ext-install-hint">选择扩展目录或 .ts/.js 文件，安装到 ~/.pi/agent/extensions/</span>
              </div>
            )}

            {loading ? (
              <div className="ext-loading">加载中…</div>
            ) : error ? (
              <div className="ext-error">{error}</div>
            ) : tab === "installed" ? (
              <div className="ext-mgr-body">
                {installed.length === 0 ? (
                  <div className="ext-empty">
                    暂无已安装的扩展。点击上方「安装扩展」按钮开始安装。
                  </div>
                ) : (
                  <div className="ext-group">
                    <div className="ext-group-title">已安装扩展 ({installed.length})</div>
                    {installed.map((ext) => (
                      <div key={ext.name} className="ext-item ext-installed-item">
                        <div className="ext-item-main">
                          <span className="ext-item-name">{ext.name}</span>
                          {ext.description && <span className="ext-item-desc">{ext.description}</span>}
                          <span className="ext-item-meta">
                            {ext.isDir ? "📁 目录" : "📄 文件"} · {formatSize(ext.size)}
                          </span>
                        </div>
                        <div className="ext-item-actions">
                          <button
                            className="ext-item-btn"
                            onClick={() => viewFile(ext.path, ext.name)}
                          >
                            查看
                          </button>
                          <button
                            className="ext-item-btn ext-item-btn-danger"
                            onClick={() => handleUninstall(ext.name)}
                          >
                            卸载
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="ext-mgr-body">
                {skills.length > 0 && (
                  <div className="ext-group">
                    <div className="ext-group-title">技能 (Skills)</div>
                    {skills.map((c) => (
                      <div key={c.name} className="ext-item" onClick={() => c.path && viewFile(c.path, c.name)}>
                        <div className="ext-item-main">
                          <span className="ext-item-name">{c.name}</span>
                          {c.description && <span className="ext-item-desc">{c.description}</span>}
                        </div>
                        {c.path && <span className="ext-item-view">查看</span>}
                        {c.location && <span className="ext-item-loc">{c.location}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {extensions.length > 0 && (
                  <div className="ext-group">
                    <div className="ext-group-title">扩展命令 (Extensions)</div>
                    {extensions.map((c) => (
                      <div key={c.name} className="ext-item" onClick={() => c.path && viewFile(c.path, c.name)}>
                        <div className="ext-item-main">
                          <span className="ext-item-name">/{c.name}</span>
                          {c.description && <span className="ext-item-desc">{c.description}</span>}
                        </div>
                        {c.path && <span className="ext-item-view">查看</span>}
                      </div>
                    ))}
                  </div>
                )}
                {prompts.length > 0 && (
                  <div className="ext-group">
                    <div className="ext-group-title">Prompt 模板</div>
                    {prompts.map((c) => (
                      <div key={c.name} className="ext-item" onClick={() => c.path && viewFile(c.path, c.name)}>
                        <div className="ext-item-main">
                          <span className="ext-item-name">/{c.name}</span>
                          {c.description && <span className="ext-item-desc">{c.description}</span>}
                        </div>
                        {c.path && <span className="ext-item-view">查看</span>}
                        {c.location && <span className="ext-item-loc">{c.location}</span>}
                      </div>
                    ))}
                  </div>
                )}
                {commands.length === 0 && (
                  <div className="ext-empty">没有已加载的命令。请在 ~/.pi/agent/ 下配置扩展与技能。</div>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn-primary" onClick={onClose}>关闭</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
