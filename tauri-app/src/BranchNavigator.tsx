import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface TreeNode {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  children: TreeNode[];
  depth: number;
  isCurrent: boolean;
  hasMultipleChildren: boolean;
}

interface BranchNavigatorProps {
  sessionPath: string | null;
  onSwitchBranch: (entryId: string) => Promise<void>;
}

function buildTree(entries: any[]): { roots: TreeNode[]; currentId: string | null } {
  if (!Array.isArray(entries) || entries.length === 0) return { roots: [], currentId: null };

  const nodes = new Map<string, TreeNode>();
  let currentId: string | null = null;

  for (const e of entries) {
    const id = e.entryId || e.id || String(e._id || "");
    if (!id) continue;
    const parentId = e.parentId || e.parent || null;
    const role = e.role || "assistant";
    let text = "";
    if (e.content) {
      if (typeof e.content === "string") text = e.content;
      else if (Array.isArray(e.content)) {
        text = e.content.map((c: any) => c.text || c.content || "").join(" ").trim();
      } else if (e.content.text) text = e.content.text;
    } else if (e.message?.content) {
      text = typeof e.message.content === "string" ? e.message.content : "";
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text.length > 80) text = text.slice(0, 80) + "…";
    nodes.set(id, {
      id, parentId, role, text,
      children: [],
      depth: 0,
      isCurrent: !!e.isCurrent || !!e.current,
      hasMultipleChildren: false,
    });
    if (e.isCurrent || e.current) currentId = id;
  }

  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) {
      const parent = nodes.get(node.parentId)!;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  function calcDepth(node: TreeNode, d: number) {
    node.depth = d;
    node.hasMultipleChildren = node.children.length > 1;
    for (const c of node.children) calcDepth(c, d + 1);
  }
  for (const r of roots) calcDepth(r, 0);

  return { roots, currentId };
}

function BranchNode({
  node,
  onSelect,
  currentId,
}: {
  node: TreeNode;
  onSelect: (id: string) => void;
  currentId: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const isCurrent = node.id === currentId;

  const roleIcon = node.role === "user" ? "👤" : node.role === "assistant" ? "🤖" : node.role === "tool" ? "🔧" : "📝";

  return (
    <div className="branch-node">
      <div
        className={`branch-node-row ${isCurrent ? "current" : ""} ${node.role}`}
        onClick={() => onSelect(node.id)}
        title={node.text || "(empty)"}
      >
        {node.children.length > 0 ? (
          <button
            className="branch-collapse-btn"
            onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}
          >
            {collapsed ? "▶" : "▼"}
          </button>
        ) : (
          <span className="branch-collapse-spacer" />
        )}
        <span className="branch-node-icon">{roleIcon}</span>
        <span className="branch-node-text">{node.text || "(empty)"}</span>
        {node.hasMultipleChildren && (
          <span className="branch-fork-badge" title="此处有分支">⑂</span>
        )}
      </div>
      {!collapsed && node.children.length > 0 && (
        <div className="branch-children">
          {node.children.map((c) => (
            <BranchNode key={c.id} node={c} onSelect={onSelect} currentId={currentId} />
          ))}
        </div>
      )}
    </div>
  );
}

export function BranchNavigator({ sessionPath, onSwitchBranch }: BranchNavigatorProps) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTree = useCallback(async () => {
    if (!sessionPath) { setRoots([]); setCurrentId(null); return; }
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<any>("send_request", { command: { type: "get_tree" } });
      const entries = Array.isArray(data) ? data : (data?.entries || data?.tree || data?.nodes || []);
      const { roots: r, currentId: cid } = buildTree(entries);
      setRoots(r);
      setCurrentId(cid);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionPath]);

  useEffect(() => { loadTree(); }, [loadTree]);

  const handleSelect = useCallback(async (entryId: string) => {
    if (entryId === currentId) return;
    try {
      await onSwitchBranch(entryId);
      setCurrentId(entryId);
    } catch (e) {
      setError(`切换失败: ${e}`);
    }
  }, [currentId, onSwitchBranch]);

  return (
    <div className="branch-navigator">
      <div className="branch-nav-header">
        <span className="branch-nav-title">会话分支</span>
        <button className="branch-refresh-btn" onClick={loadTree} title="刷新">↻</button>
      </div>
      {loading ? (
        <div className="branch-loading">加载中…</div>
      ) : error ? (
        <div className="branch-error">{error}</div>
      ) : roots.length === 0 ? (
        <div className="branch-empty">暂无分支数据</div>
      ) : (
        <div className="branch-tree">
          {roots.map((r) => (
            <BranchNode key={r.id} node={r} onSelect={handleSelect} currentId={currentId} />
          ))}
        </div>
      )}
    </div>
  );
}
