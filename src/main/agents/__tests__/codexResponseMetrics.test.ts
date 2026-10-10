import { describe, expect, it } from "vitest";
import { CodexResponseMetrics } from "../codex/codexResponseMetrics.js";

function fixture() {
  let at = 0;
  const metrics = new CodexResponseMetrics(() => at);
  metrics.start();
  return { metrics, time: (value: number) => { at = value; } };
}

describe("Codex 平均响应吞吐", () => {
  it("计入首次可见输出前的请求等待和隐藏思考，排除 CLI 启动", () => {
    const f = fixture();
    f.time(1000);
    f.metrics.beginTurn("turn-1");
    f.time(6940);
    f.metrics.output("摘要");
    f.time(9490);
    f.metrics.output("最终回复");
    expect(f.metrics.snapshot(941)).toEqual({ ttftMs: 6940 });
    f.time(10500);
    f.metrics.finishTurn("completed", 9500);
    f.metrics.finish();
    expect(f.metrics.snapshot(941)).toEqual({
      ttftMs: 6940, outputTokensPerSecond: 941 / 9.5,
      outputSpeedBasis: "activeTurn", outputSpeedDurationMs: 9500,
    });
  });

  it("重叠的工具和审批只扣除一次，重复生命周期事件不会重复扣时", () => {
    const f = fixture();
    f.metrics.beginTurn("turn-1");
    f.time(500);
    f.metrics.output("工具前回复");
    f.time(1000);
    f.metrics.item("commandExecution", "tool-1", true);
    f.time(2000);
    f.metrics.item("mcpToolCall", "tool-2", true);
    f.metrics.approval("approval-1", true);
    f.time(3000);
    f.metrics.approval("approval-1", false);
    f.metrics.item("commandExecution", "tool-1", true);
    f.time(5000);
    f.metrics.item("mcpToolCall", "tool-2", false);
    f.time(6000);
    f.metrics.item("commandExecution", "tool-1", false);
    f.metrics.item("commandExecution", "tool-1", false);
    f.time(10000);
    f.metrics.finishTurn("completed", 10000);
    f.metrics.finish();
    expect(f.metrics.snapshot(250)).toMatchObject({ outputTokensPerSecond: 50, outputSpeedDurationMs: 5000 });
  });

  it("工具仍在运行时可观察到模型输出，该模型活动时间不会被扣除", () => {
    const f = fixture();
    f.metrics.beginTurn("turn-1");
    f.time(1000);
    f.metrics.item("commandExecution", "tool-1", true);
    f.time(3000);
    f.metrics.item("reasoning", "reasoning-1", true);
    f.time(4000);
    f.metrics.output("工具期间的思考");
    f.time(5000);
    f.metrics.item("reasoning", "reasoning-1", false);
    f.time(6000);
    f.metrics.item("commandExecution", "tool-1", false);
    f.time(10000);
    f.metrics.finishTurn("completed", 10000);
    f.metrics.finish();
    expect(f.metrics.snapshot(350)).toMatchObject({ outputTokensPerSecond: 50, outputSpeedDurationMs: 7000 });
  });

  it("CLI 集中推送事件时，服务端完整轮次耗时不会被短暂接收间隔压缩", () => {
    const f = fixture();
    f.metrics.beginTurn("turn-1");
    f.time(10);
    f.metrics.output("集中到达的回复");
    f.time(50);
    f.metrics.finishTurn("completed", 10000);
    f.metrics.finish();
    expect(f.metrics.snapshot(500)).toMatchObject({ outputTokensPerSecond: 50, outputSpeedDurationMs: 10000 });
  });

  it("中断、缺少工具起止配对或无有效用量时，不显示吞吐", () => {
    const f = fixture();
    f.metrics.beginTurn("turn-1");
    f.time(1000);
    f.metrics.output("回复");
    f.time(2000);
    f.metrics.finishTurn("interrupted", 2000);
    f.metrics.finish();
    expect(f.metrics.snapshot(100)).toEqual({ ttftMs: 1000 });
    f.metrics.start();
    f.metrics.beginTurn("turn-2");
    f.time(3000);
    f.metrics.output("回复");
    f.metrics.item("commandExecution", "missing-start", false);
    f.time(4000);
    f.metrics.finishTurn("completed", 2000);
    f.metrics.finish();
    expect(f.metrics.snapshot(100)).toEqual({ ttftMs: 1000 });
    f.metrics.start();
    f.metrics.beginTurn("turn-3");
    f.time(5000);
    f.metrics.output("回复");
    f.time(6000);
    f.metrics.finishTurn("completed", 2000);
    f.metrics.finish();
    for (const tokens of [undefined, 0, -1, NaN, Infinity]) {
      expect(f.metrics.snapshot(tokens)).toEqual({ ttftMs: 1000 });
    }
  });

  it("下一轮清空计时，并以 turnId 隔离旧轮延迟事件", () => {
    const f = fixture();
    expect(f.metrics.acceptsTurn("turn-1")).toBe(false);
    f.metrics.beginTurn("turn-1");
    expect(f.metrics.acceptsTurn("turn-1")).toBe(true);
    f.time(1000);
    f.metrics.output("回复");
    f.metrics.finishTurn("completed", 1000);
    f.metrics.finish();
    f.metrics.start();
    expect(f.metrics.snapshot()).toEqual({});
    expect(f.metrics.acceptsTurn("turn-1")).toBe(false);
    expect(f.metrics.beginTurn("turn-1")).toBe(false);
    f.metrics.beginTurn("turn-2");
    expect(f.metrics.acceptsTurn("turn-1")).toBe(false);
    expect(f.metrics.acceptsTurn("turn-2")).toBe(true);
  });
});
