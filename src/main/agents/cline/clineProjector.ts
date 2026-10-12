import type { AssistantTextRow, ReasoningRow, ToolCallRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import type { ChatUsage } from "../../../shared/types.js";
import { imageAttachment, inputAttachments, isRecord, localImageAttachment, parseTime, RowProjectorBase, truncate, type JsonRecord, type UserAttachment } from "../rowProjectorBase.js";
import { extractFileReferences } from "../fileAttachments.js";

const SYNTHETIC_KINDS = new Set(["auto_compaction", "compaction_budget_emergency", "completion_reminder", "loop_detection_notice", "manual_compaction", "mistake_stop_notice", "recovery_notice", "compaction", "compaction_summary"]);

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => isRecord(part) ? outputText(part.text ?? part.content) : "").filter(Boolean).join("\n");
  return value === undefined ? "" : JSON.stringify(value);
}

export function clineUserText(text: string): string {
  return text.replace(/<mode_notice\b[^>]*>[\s\S]*?<\/mode_notice>/g, "")
    .replace(/^\s*<user_input\b[^>]*>\s*([\s\S]*?)\s*<\/user_input>\s*$/, "$1").trim();
}

export class ClineRowProjector extends RowProjectorBase {
  private textRow: number | undefined;
  private textKind: "assistantText" | "reasoning" | undefined;
  private turnMetrics: JsonRecord[] = [];

  get lastTurnUsage(): ChatUsage {
    const usage: ChatUsage = {};
    for (const key of ["inputTokens", "outputTokens"] as const) {
      if (this.turnMetrics.length && this.turnMetrics.every((sample) => typeof sample[key] === "number" && Number.isFinite(sample[key]) && (sample[key] as number) >= 0)) {
        usage[key] = this.turnMetrics.reduce((sum, sample) => sum + (sample[key] as number), 0);
      }
    }
    return usage;
  }

  get lastTurnError(): string | undefined {
    const rows = this.snapshot();
    const turn = rows.findLast((row) => row.kind === "turnHeader");
    if (turn?.kind !== "turnHeader" || turn.state !== "failed") return undefined;
    const error = rows.findLast((row) => row.turnId === turn.turnId && row.kind === "assistantText" && row.state === "failed");
    return error?.kind === "assistantText" ? error.text : undefined;
  }

  update(update: JsonRecord, at = Date.now()) {
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        const content = isRecord(update.content) ? update.content : {};
        if (content.type === "text" && typeof content.text === "string") {
          const text = clineUserText(content.text);
          const current = [...this.rows.values()].filter((row) => row.turnId === this.turn?.turnId);
          const input = current.find((row) => row.kind === "userInput");
          if (input && current.every((row) => row.kind === "turnHeader" || row.kind === "userInput")) this.append(input.rowId, "text", text);
          else this.beginUserTurn(text, at);
        }
        else if (content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string") {
          const input = [...this.rows.values()].findLast((row) => row.kind === "userInput" && row.turnId === this.turn?.turnId);
          if (input) this.patch<UserInputRow>(input.rowId, (row) => ({ ...row, attachments: [...(row.attachments ?? []), imageAttachment(content.mimeType as string, content.data as string)] }));
          else this.beginUserTurn("", at, undefined, [imageAttachment(content.mimeType, content.data)]);
        }
        break;
      }
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = isRecord(update.content) ? update.content : {};
        if (content.type !== "text" || typeof content.text !== "string" || !content.text) return;
        this.text(update.sessionUpdate === "agent_thought_chunk" ? "reasoning" : "assistantText", content.text, at);
        break;
      }
      case "tool_call":
      case "tool_call_update": this.tool(update, at); break;
    }
  }

  private finishText() {
    if (this.textRow !== undefined) this.patch<AssistantTextRow | ReasoningRow>(this.textRow, (row) => ({ ...row, state: "complete" }));
    this.textRow = undefined;
    this.textKind = undefined;
  }

  private text(kind: "assistantText" | "reasoning", text: string, at: number) {
    this.ensureTurn(at);
    if (this.textRow === undefined || this.textKind !== kind) {
      this.finishText();
      const row: AssistantTextRow | ReasoningRow = { ...this.base(at), kind, text, state: "streaming" };
      this.put(row);
      this.textRow = row.rowId;
      this.textKind = kind;
    } else this.append(this.textRow, "text", text);
  }

  private tool(update: JsonRecord, at: number) {
    if (typeof update.toolCallId !== "string") return;
    this.ensureTurn(at);
    this.finishText();
    let rowId = this.toolRows.get(update.toolCallId);
    const title = typeof update.title === "string" ? update.title : undefined;
    const input = isRecord(update.rawInput) ? update.rawInput : undefined;
    if (rowId === undefined) rowId = this.createToolRow(update.toolCallId, title?.split(":")[0] ?? String(update.kind ?? "工具"), input, at, "running");
    this.patch<ToolCallRow>(rowId, (row) => ({
      ...row,
      ...(title ? { toolName: title.split(":")[0]! } : {}),
      ...(input ? { input, inputText: JSON.stringify(input) } : {}),
      // pending 同时用于输入与审批前；保留宿主标记的 pendingApproval。
      ...(update.status === "in_progress" ? { status: "running" as const } : {}),
      ...(update.status === "completed" || update.status === "failed" ? {
        status: update.status === "completed" ? "success" as const : "error" as const,
        endedAt: at,
      } : {}),
      ...(update.rawOutput !== undefined || update.content !== undefined ? {
        output: { text: truncate(outputText(update.rawOutput ?? (Array.isArray(update.content) ? update.content.map((part) => isRecord(part) ? part.content : part) : update.content))) },
      } : {}),
      raw: update,
    }));
  }

  history(messages: readonly unknown[]) {
    let lastAt = 0;
    for (const value of messages) {
      if (!isRecord(value)) continue;
      const message = value;
      const metadata = isRecord(message.metadata) ? message.metadata : {};
      const at = typeof message.ts === "number" ? message.ts : parseTime(message.ts, lastAt + 1);
      lastAt = Math.max(lastAt, at);
      const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content.filter(isRecord) : [];
      const displayRole = String(metadata.displayRole ?? message.role);
      if (displayRole === "error") {
        const error = outputText(blocks);
        if (error.trim()) this.failTurn(error, at);
        continue;
      }
      if (["system", "status"].includes(displayRole)) continue;
      if (message.role === "user") {
        const text = clineUserText(blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("\n"));
        const images: UserAttachment[] = blocks.filter((block) => block.type === "image" && typeof block.data === "string" && typeof block.mediaType === "string")
          .map((block) => imageAttachment(block.mediaType as string, block.data as string));
        const restored = extractFileReferences(text);
        for (const file of restored.files) {
          const thumbnail = file.mimeType.startsWith("image/") ? localImageAttachment(file.path) : null;
          images.push(thumbnail ? { ...thumbnail, fileName: file.name } : inputAttachments(undefined, [file])[0]!);
        }
        const synthetic = metadata.userRunSpan === 0 || SYNTHETIC_KINDS.has(String(metadata.kind)) || text.startsWith("[TASK RESUMPTION]") || text === "The user approved switching to act mode. Continue with the approved plan now.";
        if (!synthetic && (text || images.length)) {
          this.turnMetrics = [];
          this.beginUserTurn(restored.text, at, undefined, images);
        }
      }
      if (message.role === "assistant" && metadata.displayOnly !== true) this.turnMetrics.push(isRecord(message.metrics) ? message.metrics : {});
      // 提供商内置工具的历史保存在 sidecar metadata 中。
      for (const activity of Array.isArray(metadata.modelToolActivities) ? metadata.modelToolActivities.filter(isRecord) : []) {
        this.tool({ sessionUpdate: "tool_call", toolCallId: activity.toolCallId, title: activity.toolName, rawInput: activity.input }, at);
        if (activity.output !== undefined || activity.isError !== undefined) this.tool({ sessionUpdate: "tool_call_update", toolCallId: activity.toolCallId, status: activity.isError ? "failed" : "completed", rawOutput: activity.output }, at);
      }
      for (const block of blocks) {
        if (block.type === "text" && message.role === "assistant" && typeof block.text === "string") this.text("assistantText", block.text, at);
        else if (block.type === "thinking" && typeof block.thinking === "string") this.text("reasoning", block.thinking, at);
        else if (block.type === "tool_use") this.tool({ sessionUpdate: "tool_call", toolCallId: block.id, title: block.name, rawInput: block.input }, at);
        else if (block.type === "tool_result") this.tool({ sessionUpdate: "tool_call_update", toolCallId: block.tool_use_id, status: block.is_error ? "failed" : "completed", rawOutput: block.content }, at);
      }
      this.finishText();
    }
    this.closeTurn(lastAt);
    this.drain();
  }

  protected override onTurnClosed() { this.textRow = undefined; this.textKind = undefined; }
}
