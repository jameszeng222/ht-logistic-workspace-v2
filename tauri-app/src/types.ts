// 共享类型定义（从 App.tsx 抽出，便于 utils.ts 与测试引用）

export interface ToolCall {
  id: string;
  name: string;
  args: any;
  result?: any;
  status: "running" | "done" | "error";
  expanded?: boolean;
}

export interface AssistantMsg {
  id: string;
  text: string;
  thinking?: string;
  streaming: boolean;
  toolCallIds: string[];
}

export interface Turn {
  id: string;
  userMessage: string;
  assistantMsgs: AssistantMsg[];
  toolCalls: Record<string, ToolCall>;
  status: "streaming" | "done";
}
