import { performance } from "node:perf_hooks";
import type { SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatUsage } from "../../../shared/types.js";
import { ResponseMetrics } from "../responseMetrics.js";

interface ResponseSample {
  startedAt: number;
  initialTokens: number;
  finalTokens?: number;
  durationMs?: number;
}

/** 将同一个主代理响应的 Token 变化量与完整响应时间配对，包含未展示的思考。 */
export class ClaudeResponseMetrics extends ResponseMetrics {
  private readonly responses = new Map<string, ResponseSample>();
  private responseId: string | undefined;
  private complete = false;

  constructor(private readonly clock: () => number = () => performance.now()) {
    super(clock);
  }

  override start() {
    super.start();
    this.responses.clear();
    this.responseId = undefined;
    this.complete = false;
  }

  consumeStream(message: SDKPartialAssistantMessage): boolean {
    // result.usage 不含子代理，因此计时与 TTFT 也只观察主代理。
    if (this.complete || message.parent_tool_use_id) return false;
    const event = message.event;
    if (event.type === "message_start") {
      const { id, usage } = event.message;
      this.responseId = id;
      if (!this.responses.has(id) && validTokens(usage.output_tokens)) {
        this.responses.set(id, { startedAt: this.clock(), initialTokens: usage.output_tokens });
      }
    } else if (event.type === "message_delta") {
      const response = this.responseId ? this.responses.get(this.responseId) : undefined;
      const tokens = event.usage.output_tokens;
      if (response && validTokens(tokens) && tokens >= response.initialTokens &&
        (response.finalTokens === undefined || tokens > response.finalTokens)) {
        response.finalTokens = tokens;
        response.durationMs = this.clock() - response.startedAt;
      }
    } else if (event.type === "message_stop") {
      this.responseId = undefined;
    } else if (event.type === "content_block_delta") {
      const delta = event.delta;
      const text = delta.type === "text_delta" ? delta.text
        : delta.type === "thinking_delta" ? delta.thinking
        : delta.type === "input_json_delta" ? delta.partial_json : undefined;
      return this.output(text);
    }
    return false;
  }

  override finish() {
    super.finish();
    this.complete = true;
  }

  override snapshot(outputTokens?: number): Pick<ChatUsage, "ttftMs" | "outputTokensPerSecond" | "outputSpeedBasis"> {
    const { ttftMs } = super.snapshot();
    const metrics: Pick<ChatUsage, "ttftMs" | "outputTokensPerSecond" | "outputSpeedBasis"> =
      ttftMs === undefined ? {} : { ttftMs };
    if (!this.complete || !validTokens(outputTokens) || !this.responses.size) return metrics;
    let totalTokens = 0;
    let generatedTokens = 0;
    let durationMs = 0;
    for (const response of this.responses.values()) {
      if (response.finalTokens === undefined || response.durationMs === undefined || response.durationMs <= 0) return metrics;
      totalTokens += response.finalTokens;
      generatedTokens += response.finalTokens - response.initialTokens;
      durationMs += response.durationMs;
    }
    // 未收到完整流、重试或非流式回退等导致计数不对应时，不能用整轮用量补入短暂的流式窗口。
    if (totalTokens === outputTokens && generatedTokens > 0 && durationMs > 0) {
      metrics.outputTokensPerSecond = generatedTokens * 1000 / durationMs;
      metrics.outputSpeedBasis = "response";
    }
    return metrics;
  }
}

function validTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
