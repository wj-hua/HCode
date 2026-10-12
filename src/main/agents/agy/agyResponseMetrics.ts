import type { ChatUsage } from "../../../shared/types.js";
import { isRecord, type JsonRecord } from "../rowProjectorBase.js";
import { ResponseMetrics } from "../responseMetrics.js";

interface ResponseSample {
  done: boolean;
  tokens?: number;
  durationSeconds?: number;
}

type Metrics = Pick<ChatUsage, "ttftMs" | "outputTokensPerSecond" | "outputSpeedBasis" | "outputSpeedDurationMs">;

/** agy 在 DONE 步骤中报告该次响应的用量和耗时，包含隐藏思考，不受 stdout 缓冲影响。 */
export class AgyResponseMetrics extends ResponseMetrics {
  private readonly responses = new Map<number, ResponseSample>();
  private active = false;
  private successful = false;
  private invalid = false;

  override start() {
    super.start();
    this.responses.clear();
    this.active = true;
    this.successful = false;
    this.invalid = false;
  }

  consumeStep(update: JsonRecord): boolean {
    if (!this.active) return false;
    if (update.step_type === "tool") {
      const info = isRecord(update.tool_info) ? update.tool_info : {};
      const parameters = info.parameters;
      // 工具名称、执行结果和空参数都不是模型首输出。
      return isRecord(parameters) && Object.keys(parameters).length > 0
        ? this.output(JSON.stringify(parameters)) : false;
    }
    if (update.step_type !== "agent_response") return false;
    const firstThinking = this.output(update.thinking_delta);
    const firstText = this.output(update.text_delta);
    const index = update.step_index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      this.invalid = true;
      return firstThinking || firstText;
    }
    const previous = this.responses.get(index);
    // 重复通知不能重复计入；最终数据可能晚于空的 DONE 通知送达。
    const sample: ResponseSample = { ...previous, done: previous?.done === true || update.state === "DONE" };
    if (update.state === "DONE") {
      const usage = isRecord(update.usage) ? update.usage : {};
      if (validNumber(usage.output_tokens)) sample.tokens = usage.output_tokens;
      if (validNumber(update.duration_seconds)) sample.durationSeconds = update.duration_seconds;
    }
    this.responses.set(index, sample);
    return firstThinking || firstText;
  }

  finishResult(status: unknown) {
    if (this.active) this.successful = status === "SUCCESS";
  }

  override finish() {
    super.finish();
    this.active = false;
  }

  override snapshot(outputTokens?: number): Metrics {
    const { ttftMs } = super.snapshot();
    const metrics: Metrics = ttftMs === undefined ? {} : { ttftMs };
    if (this.active || !this.successful || this.invalid || !this.responses.size ||
      !validNumber(outputTokens) || outputTokens <= 0) return metrics;
    let tokens = 0;
    let durationSeconds = 0;
    for (const sample of this.responses.values()) {
      if (!sample.done || sample.tokens === undefined || sample.durationSeconds === undefined || sample.durationSeconds <= 0) return metrics;
      tokens += sample.tokens;
      durationSeconds += sample.durationSeconds;
    }
    // 缺步骤、重试或累计用量基线不对应时，不能把整轮 Token 除以部分响应的时间。
    if (tokens === outputTokens && Number.isFinite(durationSeconds) && durationSeconds > 0) {
      metrics.outputTokensPerSecond = tokens / durationSeconds;
      metrics.outputSpeedBasis = "response";
      metrics.outputSpeedDurationMs = durationSeconds * 1000;
    }
    return metrics;
  }
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
