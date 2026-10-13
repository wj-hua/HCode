import { CodexResponseMetrics } from "../codex/codexResponseMetrics.js";
import type { JsonRecord } from "../rowProjectorBase.js";

/** ACP 没有逐请求计时；复用整轮吞吐计时，排除工具及审批等待。 */
export class ClineResponseMetrics extends CodexResponseMetrics {
  update(update: JsonRecord) {
    if (typeof update.toolCallId !== "string") return;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    if (update.status === "completed" || update.status === "failed") {
      this.item("dynamicToolCall", update.toolCallId, false);
    } else if (update.sessionUpdate === "tool_call" || update.status === "in_progress" || update.status === "pending") {
      this.item("dynamicToolCall", update.toolCallId, true);
    }
  }
}
