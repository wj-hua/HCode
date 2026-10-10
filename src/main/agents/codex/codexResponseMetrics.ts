import { performance } from "node:perf_hooks";
import type { ChatUsage } from "../../../shared/types.js";
import { ResponseMetrics } from "../responseMetrics.js";

const MODEL_ITEMS = new Set(["reasoning", "agentMessage", "plan"]);
const TOOL_ITEMS = new Set([
  "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall",
  "collabAgentToolCall", "collabToolCall", "webSearch", "imageView",
]);

/** Codex 未提供逐请求的解码计时：测整轮响应吞吐，扣除可识别的工具和审批等待。 */
export class CodexResponseMetrics extends ResponseMetrics {
  private turnId: string | undefined;
  private previousTurnId: string | undefined;
  private turnStartedAt: number | undefined;
  private measuredDurationMs: number | undefined;
  private complete = false;
  private successful = false;
  private invalid = false;
  private readonly modelItems = new Set<string>();
  private readonly waits = new Set<string>();
  private readonly completedTools = new Set<string>();
  private pausedAt: number | undefined;
  private pausedMs = 0;

  constructor(private readonly clock: () => number = () => performance.now()) {
    super(clock);
  }

  override start() {
    super.start();
    this.previousTurnId = this.turnId ?? this.previousTurnId;
    this.turnId = undefined;
    this.turnStartedAt = undefined;
    this.measuredDurationMs = undefined;
    this.complete = false;
    this.successful = false;
    this.invalid = false;
    this.modelItems.clear();
    this.waits.clear();
    this.completedTools.clear();
    this.pausedAt = undefined;
    this.pausedMs = 0;
  }

  beginTurn(id: string): boolean {
    if (!id || id === this.previousTurnId || (this.turnId !== undefined && id !== this.turnId)) return false;
    if (this.turnId === undefined) {
      this.turnId = id;
      this.turnStartedAt = this.clock();
    }
    return true;
  }

  /** 旧轮次的延迟事件不能混入当前轮；旧版缺少 turnId 时仍需已收到 turn/started。 */
  acceptsTurn(id: unknown): boolean {
    return this.turnId !== undefined && (typeof id !== "string" || id === this.turnId);
  }

  item(type: string, id: string, started: boolean) {
    if (this.complete || this.turnStartedAt === undefined || !id) return;
    if (MODEL_ITEMS.has(type)) {
      if (started) this.modelItems.add(id);
      else this.modelItems.delete(id);
    } else if (TOOL_ITEMS.has(type)) {
      const key = `tool:${id}`;
      if (started) {
        if (!this.completedTools.has(id)) this.waits.add(key);
      } else if (!this.completedTools.has(id)) {
        if (!this.waits.delete(key)) this.invalid = true;
        this.completedTools.add(id);
      }
    }
    this.syncPause();
  }

  approval(id: string, pending: boolean) {
    if (this.complete || this.turnStartedAt === undefined) return;
    const key = `approval:${id}`;
    if (pending) this.waits.add(key);
    else this.waits.delete(key);
    this.syncPause();
  }

  finishTurn(status: unknown, serverDurationMs?: unknown) {
    if (this.complete || this.turnStartedAt === undefined) return;
    const at = this.clock();
    if (this.pausedAt !== undefined) this.pausedMs += Math.max(0, at - this.pausedAt);
    this.pausedAt = undefined;
    const elapsed = Math.max(0, at - this.turnStartedAt);
    // CLI 缓冲可能把多条通知集中送达。完整的服务端轮次耗时能防止分母被压缩。
    const fullDuration = typeof serverDurationMs === "number" && Number.isFinite(serverDurationMs) && serverDurationMs > 0
      ? Math.max(serverDurationMs, elapsed) : elapsed;
    this.measuredDurationMs = fullDuration - this.pausedMs;
    this.successful = status === "completed";
    if (this.waits.size > 0) this.invalid = true;
    this.complete = true;
  }

  override snapshot(outputTokens?: number): Pick<ChatUsage, "ttftMs" | "outputTokensPerSecond" | "outputSpeedBasis" | "outputSpeedDurationMs"> {
    const { ttftMs } = super.snapshot();
    const metrics: Pick<ChatUsage, "ttftMs" | "outputTokensPerSecond" | "outputSpeedBasis" | "outputSpeedDurationMs"> =
      ttftMs === undefined ? {} : { ttftMs };
    if (this.complete && this.successful && !this.invalid && this.measuredDurationMs !== undefined && this.measuredDurationMs > 0 &&
      outputTokens !== undefined && Number.isFinite(outputTokens) && outputTokens > 0) {
      metrics.outputTokensPerSecond = outputTokens * 1000 / this.measuredDurationMs;
      metrics.outputSpeedBasis = "activeTurn";
      metrics.outputSpeedDurationMs = this.measuredDurationMs;
    }
    return metrics;
  }

  private syncPause() {
    const paused = this.waits.size > 0 && this.modelItems.size === 0;
    if (paused && this.pausedAt === undefined) this.pausedAt = this.clock();
    else if (!paused && this.pausedAt !== undefined) {
      this.pausedMs += Math.max(0, this.clock() - this.pausedAt);
      this.pausedAt = undefined;
    }
  }
}
