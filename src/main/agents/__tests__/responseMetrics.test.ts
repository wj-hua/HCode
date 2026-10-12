import { describe, expect, it } from "vitest";
import { ResponseMetrics } from "../responseMetrics.js";

describe("CLI 输出速度", () => {
  it("忽略空块，首输出时显示 TTFT，结束时按首尾间隔计算速度", () => {
    let at = 0;
    const metrics = new ResponseMetrics(() => at);
    metrics.start();
    at = 100;
    expect(metrics.output("")).toBe(false);
    expect(metrics.snapshot()).toEqual({});
    at = 500;
    expect(metrics.output("思考")).toBe(true);
    at = 2500;
    expect(metrics.output("回复")).toBe(false);
    expect(metrics.snapshot(101)).toEqual({ ttftMs: 500 });
    // 最后输出之后的结果收尾不影响速度。
    at = 9000;
    metrics.finish();
    expect(metrics.snapshot(101)).toEqual({ ttftMs: 500, outputTokensPerSecond: 50 });
  });

  it("分段排除工具、审批和下一次首输出等待，每段扣除首 Token", () => {
    let at = 0;
    const metrics = new ResponseMetrics(() => at);
    metrics.start();
    at = 100;
    metrics.output("检查项目");
    at = 1100;
    metrics.output("工具参数");
    metrics.endSegment();
    at = 60100;
    metrics.output("检查完毕");
    at = 63100;
    metrics.output("最终回复");
    metrics.finish();
    expect(metrics.snapshot(202)).toEqual({ ttftMs: 100, outputTokensPerSecond: 50 });
  });

  it("下一轮清空指标，历史或结束后到达的输出不开始计时", () => {
    let at = 0;
    const metrics = new ResponseMetrics(() => at);
    expect(metrics.output("历史")).toBe(false);
    metrics.start();
    at = 500;
    metrics.output("第一轮");
    at = 1500;
    metrics.output("结束");
    metrics.finish();
    at = 5000;
    expect(metrics.output("延迟事件")).toBe(false);
    expect(metrics.snapshot(51).outputTokensPerSecond).toBe(50);
    metrics.start();
    expect(metrics.snapshot()).toEqual({});
    at = 5250;
    metrics.output("第二轮");
    expect(metrics.snapshot()).toEqual({ ttftMs: 250 });
  });

  it("没有输出、一次性输出或缺少有效用量时，不编造速度", () => {
    let at = 0;
    const metrics = new ResponseMetrics(() => at);
    metrics.start();
    metrics.finish();
    expect(metrics.snapshot(100)).toEqual({});
    metrics.start();
    at = 100;
    metrics.output("一次性输出");
    metrics.finish();
    expect(metrics.snapshot(100)).toEqual({ ttftMs: 100 });
    metrics.start();
    at = 200;
    metrics.output("流式开始");
    at = 1200;
    metrics.output("流式结束");
    metrics.finish();
    for (const count of [undefined, 0, 1, -1, NaN, Infinity]) {
      expect(metrics.snapshot(count)).toEqual({ ttftMs: 100 });
    }
  });
});
