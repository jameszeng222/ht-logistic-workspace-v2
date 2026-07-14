// Pi RPC 类型定义（简化版，完整类型见 pi 仓库 packages/agent/src/types.ts）
// 用于前端类型提示；Rust 侧用 serde_json::Value 透传，不强校验

export type PiCommand =
  | { id?: string; type: "prompt"; message: string; images?: { type: "image"; data: string; mimeType: string }[]; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "abort" }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "get_tree" }
  | { id?: string; type: "get_entries"; since?: string }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "set_session_name"; name: string };
// extension_ui_response 不在 union 内：它响应 extension_ui_request，App.tsx 中以 any 形式发送，字段为 { type, id, value?, confirmed?, cancelled? }

export interface PiResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: any;
  error?: string;
}

export interface AssistantMessageEvent {
  type:
    | "start" | "text_start" | "text_delta" | "text_end"
    | "thinking_start" | "thinking_delta" | "thinking_end"
    | "toolcall_start" | "toolcall_delta" | "toolcall_end"
    | "done" | "error";
  contentIndex?: number;
  delta?: string;
  content?: string;
  partial?: any;
  toolCall?: any;
  reason?: string;
}

export type PiEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: any[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: any; toolResults: any[] }
  | { type: "message_start"; message: any }
  | { type: "message_update"; message: any; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: any }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "extension_ui_request"; id: string; method: "select" | "confirm" | "input" | "editor"; title?: string; message?: string; options?: string[]; timeout?: number }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; reason: string }
  | { type: "pi_process_exit" };
