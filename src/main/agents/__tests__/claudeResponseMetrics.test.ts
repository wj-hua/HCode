import type { SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { ClaudeResponseMetrics } from "../claude/claudeResponseMetrics.js";

function fixture() {
  let at = 0;
  const metrics = new ClaudeResponseMetrics(() => at);
  const send = (event: unknown, parent: string | null = null) => metrics.consumeStream({
    type: "stream_event", event, parent_tool_use_id: parent,
  } as SDKPartialAssistantMessage);
  const begin = (id: string, initial = 1, parent: string | null = null) => send({
    type: "message_start", message: { id, usage: { output_tokens: initial } },
  }, parent);
  const output = (parent: string | null = null) => send({
    type: "content_block_delta", delta: { type: "text_delta", text: "回复" },
  }, parent);
  const end = (tokens: number, parent: string | null = null) => {
    send({ type: "message_delta", usage: { output_tokens: tokens } }, parent);
    send({ type: "message_stop" }, parent);
  };
  metrics.start();
  return { metrics, send, begin, output, end, time: (value: number) => { at = value; } };
}

describe("Claude 完整响应速度", () => {
  it("将隐藏思考纳入时间，使用响应起止时对应的 Token 变化量", () => {
    const f = fixture();
    f.time(1000);
    f.begin("response", 11);
    // 思考阶段没有任何可见文字，摘要和答案集中在最后短暂的流式窗口。
    f.time(29000);
    expect(f.output()).toBe(true);
    f.time(31000);
    f.output();
    f.end(1851);
    expect(f.metrics.snapshot(1851)).toEqual({ ttftMs: 29000 });
    f.metrics.finish();
    expect(f.metrics.snapshot(1851)).toEqual({
      ttftMs: 29000, outputTokensPerSecond: 1840 / 30, outputSpeedBasis: "response",
    });
  });

  it("多次响应配对计时，排除中间工具和审批等待，不计入子代理流", () => {
    const f = fixture();
    f.time(100);
    f.begin("response-1", 2);
    f.time(200);
    f.output();
    f.time(2100);
    f.end(102);
    f.time(10000);
    f.begin("subagent", 1, "tool-agent");
    f.output("tool-agent");
    f.time(20000);
    f.end(500, "tool-agent");
    f.time(60000);
    f.begin("response-2", 3);
    f.time(61000);
    f.output();
    f.time(63000);
    f.end(153);
    f.metrics.finish();
    expect(f.metrics.snapshot(255)).toEqual({
      ttftMs: 200, outputTokensPerSecond: 50, outputSpeedBasis: "response",
    });
  });

  it("无法与本轮用量配对或缺少完整响应数据时，只显示 TTFT", () => {
    const f = fixture();
    f.begin("response");
    f.time(1000);
    f.output();
    f.time(2000);
    f.end(101);
    f.metrics.finish();
    for (const tokens of [undefined, 0, 200, NaN, Infinity]) {
      expect(f.metrics.snapshot(tokens)).toEqual({ ttftMs: 1000 });
    }
    f.metrics.start();
    f.begin("incomplete");
    f.time(3000);
    f.output();
    f.metrics.finish();
    expect(f.metrics.snapshot(101)).toEqual({ ttftMs: 1000 });
  });

  it("重复消息不重复计数，累计用量更新采用最终值，下一轮清空", () => {
    const f = fixture();
    f.begin("response");
    f.time(1000);
    f.begin("response");
    f.output();
    f.send({ type: "message_delta", usage: { output_tokens: 51 } });
    f.time(2000);
    f.end(101);
    f.metrics.finish();
    expect(f.metrics.snapshot(101).outputTokensPerSecond).toBe(50);
    f.time(3000);
    f.metrics.start();
    expect(f.metrics.snapshot()).toEqual({});
    f.begin("next-response");
    f.time(3100);
    f.output();
    f.time(4000);
    f.end(11);
    f.metrics.finish();
    expect(f.metrics.snapshot(11)).toEqual({ ttftMs: 100, outputTokensPerSecond: 10, outputSpeedBasis: "response" });
  });
});
