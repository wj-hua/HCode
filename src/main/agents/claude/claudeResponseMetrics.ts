import type { SDKMessage, SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { CodexResponseMetrics } from "../codex/codexResponseMetrics.js";

/** 将 Claude 生命周期映射到与 Codex 相同的整轮吞吐计时，主代理用量不含子代理。 */
export class ClaudeResponseMetrics extends CodexResponseMetrics {
  private sequence = 0;
  private responseId: string | undefined;
  private readonly toolBlocks = new Map<number, string>();

  override start(ready = true) {
    super.start();
    this.sequence++;
    this.responseId = undefined;
    this.toolBlocks.clear();
    // 冷启动等 init 后开始吞吐计时；已运行的 CLI 从发送起计时，TTFT 始终包含启动。
    if (ready) this.beginTurn(String(this.sequence));
  }

  consume(message: SDKMessage): boolean {
    if (message.type === "system" && message.subtype === "init") this.beginTurn(String(this.sequence));
    if (message.type === "stream_event") return this.consumeStream(message);
    if (message.type === "assistant" && !message.parent_tool_use_id) {
      // 完整 assistant 消息也覆盖未提供流式工具块的情况；重复工具事件由计时器去重。
      for (const block of message.message.content) {
        if (block.type === "tool_use") this.item("mcpToolCall", block.id, true);
      }
    }
    if (message.type === "user" && !message.parent_tool_use_id && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === "tool_result") this.item("mcpToolCall", block.tool_use_id, false);
      }
    }
    if (message.type === "result") {
      this.finishTurn(message.subtype === "success" && !message.is_error ? "completed" : "failed", message.duration_ms);
    }
    return false;
  }

  consumeStream(message: SDKPartialAssistantMessage): boolean {
    if (message.parent_tool_use_id) return false;
    const event = message.event;
    if (event.type === "message_start") {
      this.responseId = event.message.id;
      this.item("agentMessage", this.responseId, true);
    } else if (event.type === "message_stop") {
      if (this.responseId) this.item("agentMessage", this.responseId, false);
      this.responseId = undefined;
    } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
      this.toolBlocks.set(event.index, event.content_block.id);
    } else if (event.type === "content_block_stop") {
      const id = this.toolBlocks.get(event.index);
      if (id) {
        // 参数生成仍属于模型响应，工具块完整后才开始等待执行结果。
        this.item("mcpToolCall", id, true);
        this.toolBlocks.delete(event.index);
      }
    } else if (event.type === "content_block_delta") {
      const delta = event.delta;
      const text = delta.type === "text_delta" ? delta.text
        : delta.type === "thinking_delta" ? delta.thinking
        : delta.type === "input_json_delta" ? delta.partial_json : undefined;
      return this.output(text);
    }
    return false;
  }
}
