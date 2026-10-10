import { performance } from "node:perf_hooks";
import type { ChatUsage } from "../../shared/types.js";

/** CLI 按块推送输出，只能测到客户端观察值，不能当作服务端逐 Token 的精确解码速度。 */
export class ResponseMetrics {
  private startedAt: number | undefined;
  private firstAt: number | undefined;
  private segmentFirstAt: number | undefined;
  private segmentLastAt: number | undefined;
  private durationMs = 0;
  private segments = 0;
  private hasUnmeasurableSegment = false;
  private finished = false;

  constructor(private readonly now: () => number = () => performance.now()) {}

  start() {
    this.startedAt = this.now();
    this.firstAt = undefined;
    this.segmentFirstAt = undefined;
    this.segmentLastAt = undefined;
    this.durationMs = 0;
    this.segments = 0;
    this.hasUnmeasurableSegment = false;
    this.finished = false;
  }

  /** 返回 true 时首次输出刚到达，需要向界面推送 TTFT。空块、工具结果不调用此方法。 */
  output(text: unknown): boolean {
    if (this.startedAt === undefined || this.finished || typeof text !== "string" || !text) return false;
    const at = this.now();
    const first = this.firstAt === undefined;
    this.firstAt ??= at;
    this.segmentFirstAt ??= at;
    this.segmentLastAt = at;
    return first;
  }

  /** 每次模型回复结束时结算；工具执行、审批和下一次首输出等待不进入分母。 */
  endSegment() {
    if (this.segmentFirstAt === undefined || this.segmentLastAt === undefined) return;
    const duration = this.segmentLastAt - this.segmentFirstAt;
    this.durationMs += Math.max(0, duration);
    this.segments++;
    if (duration <= 0) this.hasUnmeasurableSegment = true;
    this.segmentFirstAt = undefined;
    this.segmentLastAt = undefined;
  }

  finish() {
    this.endSegment();
    this.finished = true;
  }

  snapshot(outputTokens?: number): Pick<ChatUsage, "ttftMs" | "outputTokensPerSecond"> {
    if (this.startedAt === undefined || this.firstAt === undefined) return {};
    const metrics: Pick<ChatUsage, "ttftMs" | "outputTokensPerSecond"> = {
      ttftMs: Math.max(0, this.firstAt - this.startedAt),
    };
    // 每段扣除计时起点的首 Token。仅一次性收到整段文本时，无法测量输出速度。
    if (this.finished && !this.hasUnmeasurableSegment && this.durationMs > 0 &&
      outputTokens !== undefined && Number.isFinite(outputTokens) && outputTokens > this.segments) {
      metrics.outputTokensPerSecond = (outputTokens - this.segments) * 1000 / this.durationMs;
    }
    return metrics;
  }
}
