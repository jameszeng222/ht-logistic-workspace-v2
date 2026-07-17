import { describe, it, expect } from "vitest";
import { rebuildTurnsFromMessages, extractAssistantMessageContent, extractTextFromContent, formatPiError } from "./utils";

describe("extractTextFromContent", () => {
  it("字符串直接返回", () => {
    expect(extractTextFromContent("hello")).toBe("hello");
  });
  it("非数组返回字符串化", () => {
    expect(extractTextFromContent(null)).toBe("");
    expect(extractTextFromContent(123)).toBe("123");
  });
  it("从 content 块数组提取 text", () => {
    const blocks = [
      { type: "text", text: "foo" },
      { type: "thinking", thinking: "ignored" },
      { type: "text", text: "bar" },
    ];
    expect(extractTextFromContent(blocks)).toBe("foobar");
  });
  it("忽略非 text 块", () => {
    expect(extractTextFromContent([{ type: "image", url: "x" }])).toBe("");
  });
});

describe("assistant stream helpers", () => {
  it("从最终消息恢复完整文本、思考和错误", () => {
    expect(extractAssistantMessageContent({
      content: [
        { type: "thinking", thinking: "分析" },
        { type: "text", text: "结论" },
      ],
      errorMessage: "provider failed",
    })).toEqual({ text: "结论", thinking: "分析", error: "provider failed" });
  });

  it("把 tiers 配置错误转换成可操作提示", () => {
    expect(formatPiError("Cannot read properties of undefined (reading 'tiers')")).toContain("自动修复");
  });
});

describe("rebuildTurnsFromMessages", () => {
  it("空数组返回空", () => {
    expect(rebuildTurnsFromMessages([])).toEqual([]);
  });

  it("user + assistant 文本重建为一个 turn", () => {
    const msgs = [
      { role: "user", content: "你好", timestamp: 1000 },
      { role: "assistant", id: "a1", content: [{ type: "text", text: "你好啊" }], timestamp: 1001 },
    ];
    const turns = rebuildTurnsFromMessages(msgs);
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage).toBe("你好");
    expect(turns[0].assistantMsgs).toHaveLength(1);
    expect(turns[0].assistantMsgs[0].text).toBe("你好啊");
    expect(turns[0].assistantMsgs[0].id).toBe("a1");
    expect(turns[0].status).toBe("done");
  });

  it("user content 为块数组时也能提取文本", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "块内容" }], timestamp: 1 },
      { role: "assistant", id: "a", content: [{ type: "text", text: "回复" }], timestamp: 2 },
    ];
    expect(rebuildTurnsFromMessages(msgs)[0].userMessage).toBe("块内容");
  });

  it("thinking 块累积到 assistantMsg.thinking", () => {
    const msgs = [
      { role: "user", content: "q", timestamp: 1 },
      {
        role: "assistant", id: "a", timestamp: 2,
        content: [{ type: "thinking", thinking: "想" }, { type: "thinking", thinking: "考" }, { type: "text", text: "答" }],
      },
    ];
    const am = rebuildTurnsFromMessages(msgs)[0].assistantMsgs[0];
    expect(am.thinking).toBe("想考");
    expect(am.text).toBe("答");
  });

  it("历史错误消息保留已输出内容并标记中断", () => {
    const turns = rebuildTurnsFromMessages([
      { role: "user", content: "q", timestamp: 1 },
      {
        role: "assistant",
        id: "a",
        timestamp: 2,
        stopReason: "error",
        errorMessage: "Cannot read properties of undefined (reading 'tiers')",
        content: [{ type: "text", text: "半截回答" }],
      },
    ]);
    expect(turns[0].assistantMsgs[0].text).toBe("半截回答");
    expect(turns[0].assistantMsgs[0].error).toContain("自动修复");
  });

  it("toolCall 块与 toolResult 关联", () => {
    const msgs = [
      { role: "user", content: "查库", timestamp: 1 },
      {
        role: "assistant", id: "a", timestamp: 2,
        content: [{ type: "toolCall", id: "tc1", name: "query_database", arguments: { sql: "SELECT 1" } }],
      },
      { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "1" }], isError: false },
    ];
    const turn = rebuildTurnsFromMessages(msgs)[0];
    expect(Object.keys(turn.toolCalls)).toHaveLength(1);
    const tc = turn.toolCalls["tc1"];
    expect(tc.name).toBe("query_database");
    expect(tc.args).toEqual({ sql: "SELECT 1" });
    expect(tc.status).toBe("done");
    expect(turn.assistantMsgs[0].toolCallIds).toContain("tc1");
  });

  it("toolResult isError 标记为 error", () => {
    const msgs = [
      { role: "user", content: "q", timestamp: 1 },
      { role: "assistant", id: "a", timestamp: 2, content: [{ type: "toolCall", id: "tc1", name: "x" }] },
      { role: "toolResult", toolCallId: "tc1", content: "boom", isError: true },
    ];
    expect(rebuildTurnsFromMessages(msgs)[0].toolCalls["tc1"].status).toBe("error");
  });

  it("无 user 前导的 assistant 创建空 userMessage turn", () => {
    const msgs = [{ role: "assistant", id: "a", content: [{ type: "text", text: "孤儿" }], timestamp: 1 }];
    const turns = rebuildTurnsFromMessages(msgs);
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage).toBe("");
    expect(turns[0].assistantMsgs[0].text).toBe("孤儿");
  });

  it("多轮对话产生多个 turn", () => {
    const msgs = [
      { role: "user", content: "第一问", timestamp: 1 },
      { role: "assistant", id: "a1", content: [{ type: "text", text: "第一答" }], timestamp: 2 },
      { role: "user", content: "第二问", timestamp: 3 },
      { role: "assistant", id: "a2", content: [{ type: "text", text: "第二答" }], timestamp: 4 },
    ];
    const turns = rebuildTurnsFromMessages(msgs);
    expect(turns).toHaveLength(2);
    expect(turns[0].userMessage).toBe("第一问");
    expect(turns[1].userMessage).toBe("第二问");
  });

  it("bashExecution 重建为 bash 工具卡片", () => {
    const msgs = [
      { role: "user", content: "跑命令", timestamp: 1 },
      { role: "assistant", id: "a", content: [{ type: "text", text: "ok" }], timestamp: 2 },
      { role: "bashExecution", command: "ls", output: "file", exitCode: 0, timestamp: 3 },
    ];
    const turn = rebuildTurnsFromMessages(msgs)[0];
    const bashTcs = Object.values(turn.toolCalls).filter((t) => t.name === "bash");
    expect(bashTcs).toHaveLength(1);
    expect(bashTcs[0].args).toEqual({ command: "ls" });
    expect(bashTcs[0].result).toBe("file");
    expect(bashTcs[0].status).toBe("done");
  });

  it("bashExecution 非零 exitCode 标记 error", () => {
    const msgs = [
      { role: "user", content: "q", timestamp: 1 },
      { role: "bashExecution", command: "bad", output: "err", exitCode: 1, timestamp: 2 },
    ];
    const turn = rebuildTurnsFromMessages(msgs)[0];
    expect(Object.values(turn.toolCalls)[0].status).toBe("error");
  });
});
