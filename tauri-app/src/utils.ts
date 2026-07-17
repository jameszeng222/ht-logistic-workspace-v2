// 历史重建工具（从 App.tsx 抽出，便于单元测试）
// 把 Pi get_messages 返回的消息列表重建为 UI 的 turns 结构。

import type { Turn, AssistantMsg, ToolCall } from "./types";

// Pi 在新建会话时会输出一段教程欢迎语（中英文皆有），可能作为对首条消息的回复出现，
// 也可能无前置 user 消息自发输出。这里统一过滤掉。
// 判定：助手文本命中教程签名即可，不要求 userMessage 为空（Pi 会把教程当首条消息的回复）。
const TUTORIAL_SIGNATURES = [
  // 英文签名
  "Welcome to Pi — your",
  "Welcome to Pi - your",
  "Welcome to Pi — your local",
  "interactive tutorial",
  "agentic coding environment",
  "What kind of small app would you like to build",
  // 中文签名
  "欢迎来到 Pi",
  "欢迎来到Pi",
  "教程之旅",
  "我是 Pi",
  "我是Pi",
  "你的 AI 编程搭档",
  "AI 编程搭档",
  "协作方式",
  "你想搭个什么小东西",
  "你想搭个什么小工具",
];
export function isTutorialWelcome(userMessage: string, assistantText: string): boolean {
  return TUTORIAL_SIGNATURES.some((s) => assistantText.includes(s));
}

/**
 * 从 Pi 的 get_messages 响应重建 turns。
 * messages 形如 [{role:"user",content:"..."/[{type:"text",text}],timestamp},
 *                {role:"assistant",content:[{type:"text"|"thinking"|"toolCall",...}],id,timestamp},
 *                {role:"toolResult",toolCallId,content,isError},
 *                {role:"bashExecution",command,output,exitCode,timestamp}]
 */
export function rebuildTurnsFromMessages(messages: any[]): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;
  let currentAssistantMsg: AssistantMsg | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      if (currentTurn && currentAssistantMsg) currentAssistantMsg.streaming = false;
      const userText = typeof msg.content === "string"
        ? msg.content
        : extractTextFromContent(msg.content);
      currentTurn = {
        id: `turn-${msg.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        userMessage: userText,
        assistantMsgs: [],
        toolCalls: {},
        status: "done",
      };
      turns.push(currentTurn);
      currentAssistantMsg = null;
    } else if (msg.role === "assistant") {
      if (!currentTurn) {
        currentTurn = {
          id: `turn-${msg.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          userMessage: "",
          assistantMsgs: [],
          toolCalls: {},
          status: "done",
        };
        turns.push(currentTurn);
      }
      const msgId = msg.id || `msg-${msg.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const am: AssistantMsg = { id: msgId, text: "", streaming: false, toolCallIds: [] };
      const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content || "") }];
      for (const block of content) {
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") {
          am.text += block.text;
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          am.thinking = (am.thinking || "") + block.thinking;
        } else if (block.type === "toolCall" && block.id) {
          const tc: ToolCall = {
            id: block.id,
            name: block.name || "unknown",
            args: block.arguments || {},
            status: "done",
          };
          currentTurn.toolCalls[block.id] = tc;
          am.toolCallIds.push(block.id);
        }
      }
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        am.error = formatPiError(typeof msg.errorMessage === "string" ? msg.errorMessage : "回答意外中断，请重试。");
      }
      currentTurn.assistantMsgs.push(am);
      currentAssistantMsg = am;
    } else if (msg.role === "toolResult") {
      if (currentTurn && msg.toolCallId && currentTurn.toolCalls[msg.toolCallId]) {
        currentTurn.toolCalls[msg.toolCallId].result = msg.content;
        if (msg.isError) currentTurn.toolCalls[msg.toolCallId].status = "error";
      }
    } else if (msg.role === "bashExecution") {
      if (currentTurn) {
        const tcId = `bash-${msg.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const tc: ToolCall = {
          id: tcId,
          name: "bash",
          args: { command: msg.command || "" },
          result: msg.output || "",
          status: msg.exitCode === 0 ? "done" : "error",
        };
        currentTurn.toolCalls[tcId] = tc;
        if (currentAssistantMsg) currentAssistantMsg.toolCallIds.push(tcId);
      }
    }
  }
  // 过滤掉 Pi 输出的教程欢迎语（命中教程签名即过滤整个 turn，包括用户首条消息）。
  // Pi 会把教程当首条消息的回复输出，过滤后用户首条消息也一并移除，
  // 避免出现"有问无答"的孤立 user 消息。
  return turns.filter((t) => {
    const assistantText = t.assistantMsgs.map((m) => m.text).join("");
    return !isTutorialWelcome(t.userMessage, assistantText);
  });
}

/** 从 content 块数组提取纯文本（user message 用） */
export function extractTextFromContent(content: any): string {
  if (!Array.isArray(content)) return String(content || "");
  return content
    .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("");
}

export function extractAssistantMessageContent(message: any): { text: string; thinking: string; error?: string } {
  const content = Array.isArray(message?.content) ? message.content : [];
  const text = content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("");
  const thinking = content
    .filter((block: any) => block?.type === "thinking")
    .map((block: any) => typeof block.thinking === "string" ? block.thinking : (typeof block.text === "string" ? block.text : ""))
    .join("");
  const rawError = typeof message?.errorMessage === "string" ? message.errorMessage.trim() : "";
  return { text, thinking, error: rawError || undefined };
}

export function formatPiError(error: string): string {
  if (error.includes("reading 'tiers'") || error.includes('reading "tiers"')) {
    return "模型配置缺少用量信息，应用已自动修复。请重新发送这条消息。";
  }
  return error || "回答意外中断，请重试。";
}
