// src/Markdown.tsx
// Markdown 渲染：react-markdown + remark-gfm + rehype-highlight
// streaming=true 时用纯文本（避免每 delta 重渲染 AST 抖动）
//
// 注意：react-markdown v9+ 移除了 code 组件的 `inline` prop，行内代码与代码块
//       都走同一个 `code` 组件。这里用「有 language-xxx className 或内容含换行」
//       判定为代码块，否则按行内代码渲染。

import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

interface MarkdownProps {
  content: string;
  streaming?: boolean;
}

export const Markdown = memo(function Markdown({ content, streaming }: MarkdownProps) {
  // 流式中：纯文本 + 光标，避免 AST 重渲染抖动
  if (streaming) {
    return (
      <div className="md-streaming">
        {content}
        <span className="cursor">▋</span>
      </div>
    );
  }
  // 完成后：完整 Markdown 渲染
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          // 去掉外层 <pre> 包裹，让 code 组件全权负责代码块容器样式
          pre: ({ node, ...props }) => <>{props.children}</>,
          code: CodeBlock as any,
          a: ({ node, ...props }) => <a target="_blank" rel="noopener noreferrer" {...props} />,
          table: ({ node, ...props }) => <div className="md-table-wrap"><table {...props} /></div>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

// 代码块组件：语言标签 + 复制按钮
function CodeBlock({ className, children, ...props }: any) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || "");
  const text = String(children ?? "");
  // 代码块判定：有语言标注，或内容含换行（无语言的多行代码块）
  const isBlock = !!match || text.includes("\n");
  const lang = match ? match[1] : "";
  const code = text.replace(/\n$/, "");

  if (!isBlock) {
    return <code className="md-inline-code" {...props}>{children}</code>;
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="md-code-block">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || "text"}</span>
        <button className="md-code-copy" onClick={copy}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="md-code-pre">
        <code className={className} {...props}>{children}</code>
      </pre>
    </div>
  );
}
