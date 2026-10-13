import { describe, expect, it } from "vitest";
import { AgyResponseMetrics } from "../agy/agyResponseMetrics.js";

function fixture() {
  let at = 0;
  const metrics = new AgyResponseMetrics(() => at);
  metrics.start();
  return { metrics, time: (value: number) => { at = value; } };
}

const response = (index: number, tokens: number, seconds: number) => ({
  step_type: "agent_response", step_index: index, state: "DONE",
  usage: { output_tokens: tokens }, duration_seconds: seconds,
});

describe("Antigravity 响应指标", () => {
  it("工具参数计入首输出，工具结果、空参数和子代理输出不计入", () => {
    const f = fixture();
    f.time(100);
    for (const tool_info of [{ name: "run_command" }, { parameters: {} }, { output: "工具结果" }]) {
      expect(f.metrics.consumeStep({ step_type: "tool", tool_info })).toBe(false);
    }
    expect(f.metrics.consumeStep({ step_type: "subagent", text_delta: "子代理输出" })).toBe(false);
    expect(f.metrics.snapshot()).toEqual({});
    f.time(250);
    expect(f.metrics.consumeStep({ step_type: "tool", tool_info: { parameters: { CommandLine: "ls" } } })).toBe(true);
    f.time(364800);
    expect(f.metrics.consumeStep({ ...response(3, 100, 2), text_delta: "最终回复" })).toBe(false);
    expect(f.metrics.snapshot()).toEqual({ ttftMs: 250 });
  });

  it("一次性收到响应也用原生耗时计算，含无正文的工具调用响应，排除工具等待", () => {
    const f = fixture();
    f.time(1000);
    f.metrics.consumeStep(response(1, 1000, 20));
    f.metrics.consumeStep({ step_type: "tool", tool_info: { parameters: { CommandLine: "ls" } } });
    f.time(364800);
    f.metrics.consumeStep({ ...response(3, 1500, 30), text_delta: "最终回复" });
    // 相同时间送达多次通知，既不能重复用量，也不能依赖流式首尾间隔。
    f.metrics.consumeStep(response(3, 1500, 30));
    expect(f.metrics.snapshot(2500)).toEqual({ ttftMs: 1000 });
    f.metrics.finishResult("SUCCESS");
    f.metrics.finish();
    expect(f.metrics.snapshot(2500)).toEqual({
      ttftMs: 1000, outputTokensPerSecond: 50, outputSpeedBasis: "response", outputSpeedDurationMs: 50000,
    });
  });

  it("缺少完整计时、用量不对应或结果失败时不展示速度", () => {
    for (const update of [
      { ...response(1, 100, 2), duration_seconds: undefined },
      response(1, 100, 0),
      response(1, 100, NaN),
      { ...response(1, 100, 2), usage: undefined },
      { ...response(1, 100, 2), state: "RUNNING" },
      { ...response(1, 100, 2), step_index: undefined },
    ]) {
      const f = fixture();
      f.time(100);
      f.metrics.consumeStep({ ...update, text_delta: "回复" });
      f.metrics.finishResult("SUCCESS");
      f.metrics.finish();
      expect(f.metrics.snapshot(100)).toEqual({ ttftMs: 100 });
    }
    for (const status of ["SUCCESS", "ERROR"]) {
      const f = fixture();
      f.time(100);
      f.metrics.consumeStep({ ...response(1, 100, 2), text_delta: "回复" });
      f.metrics.finishResult(status);
      f.metrics.finish();
      for (const count of [undefined, 0, -1, 101, NaN, Infinity]) {
        expect(f.metrics.snapshot(count)).toEqual({ ttftMs: 100 });
      }
      if (status === "ERROR") expect(f.metrics.snapshot(100)).toEqual({ ttftMs: 100 });
    }
  });

  it("下一轮清空指标，结束后的事件不污染下一轮", () => {
    const f = fixture();
    f.time(100);
    f.metrics.consumeStep({ ...response(1, 100, 2), thinking_delta: "思考" });
    f.metrics.finishResult("SUCCESS");
    f.metrics.finish();
    f.time(5000);
    expect(f.metrics.consumeStep({ ...response(2, 1000, 1), text_delta: "延迟输出" })).toBe(false);
    expect(f.metrics.snapshot(100).outputTokensPerSecond).toBe(50);
    f.metrics.start();
    expect(f.metrics.snapshot(100)).toEqual({});
    f.time(5500);
    f.metrics.consumeStep({ ...response(3, 200, 4), text_delta: "新回复" });
    f.metrics.finishResult("SUCCESS");
    f.metrics.finish();
    expect(f.metrics.snapshot(200)).toMatchObject({ ttftMs: 500, outputTokensPerSecond: 50 });
  });
});
