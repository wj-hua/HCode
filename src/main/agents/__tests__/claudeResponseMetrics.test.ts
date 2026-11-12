import type { SDKMessage, SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { ClaudeResponseMetrics } from "../claude/claudeResponseMetrics.js";

function fixture() {
  let at = 0;
  const metrics = new ClaudeResponseMetrics(() => at);
  const send = (event: unknown, parent: string | null = null) => metrics.consumeStream({
    type: "stream_event", event, parent_tool_use_id: parent,
  } as SDKPartialAssistantMessage);
  const message = (value: unknown) => metrics.consume(value as SDKMessage);
  const begin = (id: string, parent: string | null = null) => send({ type: "message_start", message: { id } }, parent);
  const output = () => send({ type: "content_block_delta", delta: { type: "text_delta", text: "回复" } });
  const end = () => send({ type: "message_stop" });
  const tool = (id: string, index = 0) => {
    send({ type: "content_block_start", index, content_block: { type: "tool_use", id } });
    send({ type: "content_block_stop", index });
  };
  const result = (subtype = "success", duration_ms?: number) => {
    message({ type: "result", subtype, duration_ms });
    metrics.finish();
  };
  const toolResult = (id: string) => message({ type: "user", parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: id }] } });
  metrics.start();
  return { metrics, send, message, begin, output, end, tool, toolResult, result, time: (value: number) => { at = value; } };
}

describe("Claude 平均响应吞吐", () => {
  it("计入首输出前的等待、隐藏思考和完整输出用量", () => {
    const f = fixture();
    f.time(1000); f.begin("response");
    f.time(29000); expect(f.output()).toBe(true);
    f.time(31000); f.end();
    expect(f.metrics.snapshot(1851)).toEqual({ ttftMs: 29000 });
    f.result();
    expect(f.metrics.snapshot(1851)).toEqual({ ttftMs: 29000,
      outputTokensPerSecond: 1851 / 31, outputSpeedBasis: "activeTurn", outputSpeedDurationMs: 31000 });
  });

  it("并行工具和审批只扣一次，保留下一请求等待和同时发生的主代理输出", () => {
    const f = fixture();
    f.time(100); f.begin("first"); f.output(); f.tool("one"); f.tool("two", 1); f.end();
    f.time(1000); f.metrics.approval("approval", true);
    f.time(2000); f.begin("child", "one"); // 子代理不算主代理模型活动
    f.time(3000); f.metrics.approval("approval", false); f.toolResult("one");
    f.time(4000); f.begin("second"); // 主代理与工具并行输出，不扣除此时间
    f.time(5000); f.toolResult("two"); f.output(); f.end();
    f.time(10000); f.result();
    expect(f.metrics.turnStatistics()).toMatchObject({ toolCalls: 2, toolMs: 7800, responseMs: 6100 });
    expect(f.metrics.snapshot(610)).toEqual({ ttftMs: 100,
      outputTokensPerSecond: 100, outputSpeedBasis: "activeTurn", outputSpeedDurationMs: 6100 });
  });

  it("完整 assistant 工具消息兼容非流式工具，重复事件不重复扣时", () => {
    const f = fixture();
    f.time(1000); f.begin("response"); f.tool("tool");
    f.message({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "tool" }] } });
    f.end();
    f.time(3000); f.toolResult("tool"); f.toolResult("tool");
    f.time(5000); f.result();
    expect(f.metrics.snapshot(300).outputTokensPerSecond).toBe(100);
  });

  it("工具事件不完整、失败、中断或用量无效时不显示吞吐", () => {
    for (const scenario of ["missingStart", "missingEnd", "failed", "interrupted", "usage"]) {
      const f = fixture();
      f.time(1000); f.begin("response"); f.output();
      if (scenario === "missingStart") f.toolResult("unknown");
      if (scenario === "missingEnd") f.tool("tool");
      f.end(); f.time(2000);
      if (scenario === "interrupted") f.metrics.finish();
      else f.result(scenario === "failed" ? "error_during_execution" : "success");
      for (const tokens of scenario === "usage" ? [undefined, 0, NaN, Infinity] : [100]) {
        expect(f.metrics.snapshot(tokens)).toEqual({ ttftMs: 1000 });
      }
    }
  });

  it("服务端耗时防止缓冲压缩分母，下一轮清空计时", () => {
    const f = fixture();
    f.time(1000); f.output(); f.result("success", 10000);
    expect(f.metrics.snapshot(100).outputTokensPerSecond).toBe(10);
    f.metrics.start(false);
    expect(f.metrics.snapshot()).toEqual({});
    f.time(2000); f.message({ type: "system", subtype: "init" });
    f.time(3000); f.output(); f.result();
    expect(f.metrics.snapshot(100)).toEqual({ ttftMs: 2000,
      outputTokensPerSecond: 100, outputSpeedBasis: "activeTurn", outputSpeedDurationMs: 1000 });
  });
});
