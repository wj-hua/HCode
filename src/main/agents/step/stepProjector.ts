// StepCode（基于 pi）的消息 → ZCode v4 ConversationRow。
// 历史（会话 JSONL 里的 message 条目）与实时（RPC 的 message_start / message_update / message_end 等事件）共用：
// 两边都是 pi 的 AgentMessage（user / assistant / toolResult / bashExecution …）。
// step 的工具名映射到 ZCode 已认识的工具族，卡片就能直接复用：
//   read_file → Read；write_file → Write；edit_file → Edit；run_command → Bash；
//   search_files → Grep；find_files / list_directory → Glob；search_web → WebSearch；
//   task_update / task_list（带 plan 快照）→ TodoWrite。
import type {
  AssistantTextRow,
  ReasoningRow,
  TimelineMarkerRow,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { isRecord, RowProjectorBase, truncate, type JsonRecord } from "../rowProjectorBase.js";

export type StepMessage = JsonRecord & { role: string };

/** 会话文件里的一行（header 除外）。 */
export interface StepEntry extends JsonRecord {
  type: string;
  id: string;
  parentId: string | null;
  timestamp?: string;
  message?: StepMessage;
}

// ───────────────────────── 工具函数 ─────────────────────────

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[图片]");
  }
  return parts.join("\n");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** step 工具调用 → ZCode 工具名 + 输入。不认识的工具原样保留（走通用卡片）。 */
export function projectStepTool(name: string, args: JsonRecord): { toolName: string; input: JsonRecord } {
  switch (name) {
    case "read_file": {
      const start = typeof args.start_line === "number" ? args.start_line : undefined;
      const end = typeof args.end_line === "number" ? args.end_line : undefined;
      return {
        toolName: "Read",
        input: {
          file_path: str(args.path) ?? "",
          ...(start !== undefined ? { offset: start } : {}),
          ...(start !== undefined && end !== undefined ? { limit: end - start + 1 } : {}),
        },
      };
    }
    case "write_file":
      return { toolName: "Write", input: { file_path: str(args.path) ?? "", content: str(args.content) ?? "" } };
    case "edit_file":
      return {
        toolName: "Edit",
        input: { file_path: str(args.path) ?? "", old_string: str(args.search) ?? "", new_string: str(args.replace) ?? "" },
      };
    case "run_command":
      return {
        toolName: "Bash",
        input: {
          command: str(args.command) ?? "",
          ...(args.run_in_background === true ? { run_in_background: true } : {}),
          ...(typeof args.timeout_ms === "number" ? { timeout: args.timeout_ms } : {}),
        },
      };
    case "search_files":
      return { toolName: "Grep", input: { pattern: str(args.pattern) ?? "", ...(args.path ? { path: args.path } : {}) } };
    case "find_files":
      return { toolName: "Glob", input: { pattern: str(args.pattern) ?? "", ...(args.path ? { path: args.path } : {}) } };
    case "list_directory":
      return { toolName: "Glob", input: { pattern: "*", path: str(args.path) ?? "." } };
    case "search_web":
      return { toolName: "WebSearch", input: { query: str(args.query) ?? "" } };
    default:
      return { toolName: name, input: args };
  }
}

/** task_update / task_list 的结果带完整任务清单快照，显示为 TodoWrite 卡片。 */
function taskPlanTodos(details: unknown) {
  if (!isRecord(details) || !Array.isArray(details.plan)) return null;
  return details.plan.filter(isRecord).map((task) => ({
    content: String(task.subject ?? ""),
    status: task.status === "in_progress" ? "in_progress" : task.status === "completed" ? "completed" : "pending",
    ...(typeof task.activeForm === "string" ? { activeForm: task.activeForm } : {}),
  }));
}

// ───────────────────────── 投影器 ─────────────────────────

export class StepRowProjector extends RowProjectorBase {
  /** 当前流式 assistant 消息：contentIndex → 行 id */
  private readonly streamRows = new Map<number, number>();
  /** 实时发送时已在本地写过用户气泡，跳过 step 回显的第一条 user 消息。 */
  private skipNextUserEcho = false;

  beginLocalTurn(text: string, at: number) {
    this.beginUserTurn(text, at);
    this.skipNextUserEcho = true;
  }

  protected override onTurnClosed() {
    this.streamRows.clear();
    this.skipNextUserEcho = false;
  }

  /** 历史中的一个会话条目。 */
  consumeEntry(entry: StepEntry) {
    const at = entry.timestamp ? Date.parse(entry.timestamp) || Date.now() : Date.now();
    if (entry.type === "message" && entry.message) this.consumeMessage(entry.message, at);
    else if (entry.type === "compaction") this.compactionMarker(at);
  }

  /** 一条完整消息（历史条目，或实时的 message_end）。 */
  consumeMessage(message: StepMessage, at: number) {
    switch (message.role) {
      case "user": {
        if (this.skipNextUserEcho) {
          this.skipNextUserEcho = false;
          return;
        }
        const text = contentText(message.content);
        if (!text.trim()) return;
        // step 没有“轮次结束”记录：上一轮在它最后一条消息的时间结束，而不是下一条用户消息的时间
        if (this.turn) this.closeTurn(this.turn.lastAt);
        this.beginUserTurn(text, at);
        return;
      }
      case "assistant":
        this.consumeAssistant(message, at);
        return;
      case "toolResult":
        this.consumeToolResult(message, at);
        return;
      case "bashExecution": {
        // 用户在 step 里用 ! 直接执行的命令
        this.ensureTurn(at);
        const id = `bash-${at}-${this.nextRowId}`;
        const rowId = this.createToolRow(id, "Bash", { command: String(message.command ?? "") }, at, "success");
        const failed = typeof message.exitCode === "number" && message.exitCode !== 0;
        this.patch<ToolCallRow>(rowId, (row) => ({
          ...row,
          status: message.cancelled === true ? "cancelled" : failed ? "error" : "success",
          output: { text: truncate(String(message.output ?? "")) },
          endedAt: at,
        }));
        return;
      }
      case "compactionSummary":
        this.compactionMarker(at);
        return;
      default:
        return;
    }
  }

  private compactionMarker(at: number) {
    this.ensureTurn(at);
    const row: TimelineMarkerRow = {
      ...this.base(at),
      kind: "timelineMarker",
      lane: "assistantWork",
      marker: { type: "compact", origin: "auto", status: "success" },
    };
    this.put(row);
  }

  private consumeAssistant(message: StepMessage, at: number) {
    const content = Array.isArray(message.content) ? message.content : [];
    const model = str(message.model);
    this.ensureTurn(at);
    content.forEach((block, index) => {
      if (!isRecord(block)) return;
      const streamed = this.streamRows.get(index);
      if (block.type === "text" || block.type === "thinking") {
        const text = str(block.type === "text" ? block.text : block.thinking) ?? "";
        this.finalizeText(block.type, streamed, text, model, at);
      } else if (block.type === "toolCall") {
        this.upsertToolCall(str(block.id) ?? `tool-${this.nextRowId}`, str(block.name) ?? "tool", block.arguments, at);
      }
    });
    this.streamRows.clear();
    if (message.stopReason === "aborted") this.markInterrupted();
    if (message.stopReason === "error") {
      const row: AssistantTextRow = {
        ...this.base(at),
        kind: "assistantText",
        text: str(message.errorMessage) || "StepCode 执行出错",
        state: "failed",
      };
      this.put(row);
    }
  }

  private finalizeText(kind: "text" | "thinking", streamed: number | undefined, text: string, model: string | undefined, at: number) {
    if (streamed !== undefined) {
      this.patch<AssistantTextRow | ReasoningRow>(streamed, (row) => ({
        ...row,
        text: text || row.text,
        state: "complete",
        ...(kind === "text" && model ? { model } : {}),
        ...(kind === "thinking" ? { durationMs: Math.max(0, at - row.createdAt) } : {}),
      }));
      return;
    }
    if (!text.trim()) return;
    if (kind === "text") {
      const row: AssistantTextRow = { ...this.base(at), kind: "assistantText", text, state: "complete", ...(model ? { model } : {}) };
      this.put(row);
    } else {
      const row: ReasoningRow = { ...this.base(at), kind: "reasoning", text, state: "complete" };
      this.put(row);
    }
  }

  private upsertToolCall(id: string, name: string, args: unknown, at: number) {
    const { toolName, input } = projectStepTool(name, isRecord(args) ? args : {});
    const existing = this.toolRows.get(id);
    if (existing === undefined) {
      this.createToolRow(id, toolName, input, at, "running");
      return;
    }
    this.patch<ToolCallRow>(existing, (row) => ({
      ...row,
      toolName,
      input,
      inputText: JSON.stringify(input),
      status: row.status === "inputStreaming" ? "running" : row.status,
    }));
  }

  private consumeToolResult(message: StepMessage, at: number) {
    const rowId = this.toolRows.get(str(message.toolCallId) ?? "");
    if (rowId === undefined) return;
    const text = truncate(contentText(message.content));
    const isError = message.isError === true;
    const todos = taskPlanTodos(message.details);
    this.ensureTurn(at);
    this.patch<ToolCallRow>(rowId, (row) => {
      const { approvalInteractionId: _approval, ...rest } = row;
      // 用户在审批卡片上拒绝过的，保持“已取消”
      const status = row.status === "cancelled" && isError ? "cancelled" : isError ? "error" : "success";
      return {
        ...rest,
        ...(todos && !isError ? { toolName: "TodoWrite", input: { todos }, inputText: JSON.stringify({ todos }) } : {}),
        status,
        output: { text },
        ...(status === "error" ? { error: { code: "tool_error", message: text } } : {}),
        endedAt: at,
      };
    });
  }

  // ───────────────────────── 实时流 ─────────────────────────

  /** message_start：新的 assistant 消息开始流式输出。 */
  beginAssistantMessage(at: number) {
    this.ensureTurn(at);
    this.streamRows.clear();
  }

  /** message_update 里的 assistantMessageEvent。 */
  streamEvent(event: JsonRecord, at: number) {
    const index = typeof event.contentIndex === "number" ? event.contentIndex : -1;
    switch (event.type) {
      case "text_start":
      case "thinking_start": {
        this.ensureTurn(at);
        const row: AssistantTextRow | ReasoningRow =
          event.type === "text_start"
            ? { ...this.base(at), kind: "assistantText", text: "", state: "streaming" }
            : { ...this.base(at), kind: "reasoning", text: "", state: "streaming" };
        this.put(row);
        this.streamRows.set(index, row.rowId);
        break;
      }
      case "text_delta":
      case "thinking_delta": {
        const rowId = this.streamRows.get(index);
        if (rowId !== undefined && typeof event.delta === "string") this.append(rowId, "text", event.delta);
        break;
      }
      case "toolcall_start": {
        const id = str(event.id);
        if (!id || this.toolRows.has(id)) break;
        this.ensureTurn(at);
        const { toolName } = projectStepTool(str(event.toolName) ?? "tool", {});
        this.createToolRow(id, toolName, undefined, at, "inputStreaming");
        break;
      }
      case "toolcall_end": {
        const call = isRecord(event.toolCall) ? event.toolCall : null;
        if (call) this.upsertToolCall(str(call.id) ?? "", str(call.name) ?? "tool", call.arguments, at);
        break;
      }
      default:
        return;
    }
    if (this.turn) this.turn.lastAt = at;
  }

  /** tool_execution_update：partialResult 是截至目前的完整输出，整段替换。 */
  toolProgress(toolCallId: string, partial: unknown) {
    const rowId = this.toolRows.get(toolCallId);
    if (rowId === undefined || !isRecord(partial)) return;
    const text = contentText(partial.content);
    if (!text) return;
    this.patch<ToolCallRow>(rowId, (row) => ({ ...row, output: { text: truncate(text) } }));
  }

  /** 实时的压缩完成事件。 */
  compacted(at: number) {
    this.compactionMarker(at);
  }

  /** 审批时按 toolCallId 取工具行的（已映射）输入。 */
  toolInput(toolCallId: string): { toolName: string; input: JsonRecord } | undefined {
    const rowId = this.toolRows.get(toolCallId);
    const row = rowId === undefined ? undefined : this.rows.get(rowId);
    return row && row.kind === "toolCall" && isRecord(row.input) ? { toolName: row.toolName, input: row.input } : undefined;
  }
}

/**
 * 会话文件的活动分支：从最后一条条目沿 parentId 走回根（step 的会话是一棵树，/tree 切换分支后
 * 最后追加的条目就是当前叶子）。
 */
export function activeBranch(entries: readonly StepEntry[]): StepEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: StepEntry[] = [];
  let current = entries.at(-1);
  while (current && path.length <= entries.length) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

export function projectStepHistory(entries: readonly StepEntry[]): StepRowProjector {
  const projector = new StepRowProjector();
  let lastAt = 0;
  for (const entry of activeBranch(entries)) {
    projector.consumeEntry(entry);
    lastAt = Math.max(lastAt, entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0);
  }
  projector.closeTurn(lastAt || Date.now());
  projector.drain();
  return projector;
}
