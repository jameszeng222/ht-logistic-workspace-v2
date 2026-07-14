// src/CommandPalette.tsx
// 斜杠命令面板：输入 / 触发，get_commands 拉列表，上下选 + Enter/Tab 补全

import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Command {
  name: string;
  description?: string;
}

interface CommandPaletteProps {
  input: string;
  index: number;
  setIndex: (i: number) => void;
  onSelect: (text: string) => void;
}

export function CommandPalette({ input, index, setIndex, onSelect }: CommandPaletteProps) {
  const [commands, setCommands] = useState<Command[]>([]);
  const loadedRef = useRef(false);

  // 首次挂载拉命令列表
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      try {
        const data = await invoke<any>("send_request", { command: { type: "get_commands" } });
        // 容错解析：可能是数组，也可能是 { commands: [...] }
        const list = Array.isArray(data) ? data : (data?.commands || data?.list || []);
        setCommands(list.map((c: any) => ({
          name: c.name || c.command || c.id || String(c),
          description: c.description || c.desc || c.help,
        })));
      } catch {
        // get_commands 失败用内置 fallback（注意：Pi 无 /clear 命令，会话为 append-only）
        setCommands([
          { name: "new", description: "新建会话" },
          { name: "compact", description: "压缩上下文" },
          { name: "help", description: "查看帮助" },
        ]);
      }
    })();
  }, []);

  // 当前查询词（去掉开头的 /）
  const query = input.startsWith("/") ? input.slice(1).toLowerCase() : "";
  const filtered = commands.filter((c) => c.name.toLowerCase().includes(query));

  // query 变化时重置选中
  useEffect(() => { setIndex(0); }, [query, setIndex]);

  if (filtered.length === 0) return null;

  // 只渲染前 8 项；active 索引需 clamp 到可见范围内，避免越界导致 .cmd-item.active 为空
  const visible = filtered.slice(0, 8);
  const activeIdx = visible.length > 0 ? ((index % visible.length) + visible.length) % visible.length : 0;

  return (
    <div className="cmd-palette">
      <div className="cmd-palette-header">命令 · ↑↓ 选择 · Enter/Tab 补全 · Esc 关闭</div>
      {visible.map((c, i) => (
        <div
          key={c.name}
          className={`cmd-item ${i === activeIdx ? "active" : ""}`}
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(e) => { e.preventDefault(); onSelect("/" + c.name + " "); }}
        >
          <span className="cmd-name">/{c.name}</span>
          {c.description && <span className="cmd-desc">{c.description}</span>}
        </div>
      ))}
    </div>
  );
}
