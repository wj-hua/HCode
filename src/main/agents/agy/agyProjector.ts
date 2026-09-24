// Antigravity CLI（agy）的步骤 → ZCode v4 ConversationRow。
// 历史读 brain/<id>/.system_generated/logs/transcript_full.jsonl（每行一个 step），
// 实时读 `agy -p --output-format stream-json` 的 step_update 事件。两边都按 step 组织：
//   USER_INPUT → 新一轮；PLANNER_RESPONSE（thinking / content / tool_calls）→ 推理、正文、工具行；
//   GENERIC → 按顺序对应前面 PLANNER_RESPONSE 的工具调用结果；CHECKPOINT → 压缩标记。
// agy 工具映射到 ZCode 已认识的工具族：
//   view_file → Read；write_to_file → Write；(multi_)replace_file_content → Edit；run_command → Bash；
//   grep_search → Grep；find_by_name / list_dir → Glob；search_web → WebSearch；read_url_content → WebFetch。
import type {
  AssistantTextRow,
  ReasoningRow,
  TimelineMarkerRow,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  inputAttachments,
  isRecord,
  localImageAttachment,
  parseTime,
  RowProjectorBase,
  truncate,
  type JsonRecord,
  type UserAttachment,
} from "../rowProjectorBase.js";
import type { FileInput, ImageInput } from "../../../shared/types.js";

/** transcript_full.jsonl 的一行。 */
export interface AgyStep extends JsonRecord {
  step_index?: number;
  type: string;
  status?: string;
  created_at?: string;
}

// ───────────────────────── 用户输入 ─────────────────────────

/**
 * agy 自己粘贴图片时在 ADDITIONAL_METADATA 里写这段说明（并把文件存到 brain/<id>/.user_uploaded）。
 * 无头模式的 stream-json 只收文字，HCode 发图片时把同样格式的说明附在消息末尾，模型会用 view_file 读图。
 */
export function uploadedImagesNote(paths: readonly string[]): string {
  return `\n\nThe user has uploaded ${paths.length} image(s):\n${paths.map((path) => `- ${path}`).join("\n")}`;
}

const UPLOAD_NOTE = /\n*The user has uploaded \d+ image\(s\):\n((?:- [^\n]+(?:\n|$))+)/;

/** USER_INPUT 的 content 里用户实际输入的部分（agy 会包上 USER_REQUEST 与附加元数据）。 */
export function userRequestText(content: string): string {
  return /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content)?.[1] ?? content;
}

/** USER_INPUT → 用户原文 + 图片附件。 */
function parseUserInput(step: AgyStep): { text: string; attachments: UserAttachment[] } {
  let text = userRequestText(typeof step.content === "string" ? step.content : "");
  const paths = new Set<string>();
  for (const media of Array.isArray(step.media) ? step.media : []) {
    if (isRecord(media) && typeof media.uri === "string" && String(media.mime_type ?? "").startsWith("image/")) {
      paths.add(media.uri.replace(/^file:\/\//, ""));
    }
  }
  const note = UPLOAD_NOTE.exec(text);
  if (note) {
    for (const line of note[1]!.split("\n")) if (line.startsWith("- ")) paths.add(line.slice(2).trim());
    text = text.replace(note[0], "");
  }
  const attachments: UserAttachment[] = [];
  for (const path of paths) {
    const image = localImageAttachment(path);
    if (image) attachments.push(image);
    else text += `\n[图片 ${path}]`;
  }
  return { text: text.trim(), attachments };
}

// ───────────────────────── 工具 ─────────────────────────

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** agy 工具调用 → ZCode 工具名 + 输入。不认识的工具去掉 toolAction / toolSummary 后原样保留（走通用卡片）。 */
export function projectAgyTool(name: string, args: JsonRecord): { toolName: string; input: JsonRecord } {
  switch (name) {
    case "view_file": {
      const start = num(args.StartLine);
      const end = num(args.EndLine);
      return {
        toolName: "Read",
        input: {
          file_path: str(args.AbsolutePath) ?? "",
          ...(start !== undefined ? { offset: start } : {}),
          ...(start !== undefined && end !== undefined ? { limit: end - start + 1 } : {}),
        },
      };
    }
    case "write_to_file":
      return { toolName: "Write", input: { file_path: str(args.TargetFile) ?? "", content: str(args.CodeContent) ?? "" } };
    case "replace_file_content":
      return {
        toolName: "Edit",
        input: {
          file_path: str(args.TargetFile) ?? "",
          old_string: str(args.TargetContent) ?? "",
          new_string: str(args.ReplacementContent) ?? "",
        },
      };
    case "multi_replace_file_content": {
      const chunks = (Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : []).filter(isRecord);
      return {
        toolName: "Edit",
        input: {
          file_path: str(args.TargetFile) ?? "",
          old_string: chunks.map((chunk) => str(chunk.TargetContent) ?? "").join("\n…\n"),
          new_string: chunks.map((chunk) => str(chunk.ReplacementContent) ?? "").join("\n…\n"),
        },
      };
    }
    case "run_command":
      return {
        toolName: "Bash",
        input: {
          command: str(args.CommandLine) ?? "",
          ...(args.Cwd ? { cwd: args.Cwd } : {}),
          ...(args.toolSummary ? { description: args.toolSummary } : {}),
        },
      };
    case "grep_search":
      return { toolName: "Grep", input: { pattern: str(args.Query) ?? "", ...(args.SearchPath ? { path: args.SearchPath } : {}) } };
    case "find_by_name":
      return {
        toolName: "Glob",
        input: { pattern: str(args.Pattern) ?? "*", ...(args.SearchDirectory ? { path: args.SearchDirectory } : {}) },
      };
    case "list_dir":
      return { toolName: "Glob", input: { pattern: "*", path: str(args.DirectoryPath) ?? "." } };
    case "search_web":
      return { toolName: "WebSearch", input: { query: str(args.query) ?? "" } };
    case "read_url_content":
      return { toolName: "WebFetch", input: { url: str(args.Url) ?? "" } };
    default: {
      const { toolAction: _action, toolSummary: _summary, ...rest } = args;
      return { toolName: name, input: rest };
    }
  }
}

/** GENERIC 步骤的 content 以 “Created At / Completed At” 两行开头，去掉。 */
function toolOutputText(content: unknown): string {
  return typeof content === "string" ? content.replace(/^Created At: .*\n(?:Completed At: .*\n)?\n?/, "") : "";
}

// ───────────────────────── 投影器 ─────────────────────────

export class AgyRowProjector extends RowProjectorBase {
  /** 历史：等待 GENERIC 结果的工具行（按调用顺序）。 */
  private pendingTools: string[] = [];
  /** 实时：step_index → 流式文本行 / 推理行 */
  private readonly streamText = new Map<number, number>();
  private readonly streamThinking = new Map<number, number>();

  beginLocalTurn(text: string, at: number, images?: readonly ImageInput[], files?: readonly FileInput[]) {
    this.beginUserTurn(text, at, undefined, inputAttachments(images, files));
  }

  protected override onTurnClosed() {
    this.pendingTools = [];
    this.streamText.clear();
    this.streamThinking.clear();
  }

  // ───────────────────────── 历史 ─────────────────────────

  consumeStep(step: AgyStep) {
    const at = parseTime(step.created_at, Date.now());
    switch (step.type) {
      case "USER_INPUT": {
        const { text, attachments } = parseUserInput(step);
        if (!text && attachments.length === 0) return;
        // 没有“轮次结束”记录：上一轮在它最后一步的时间结束
        if (this.turn) this.closeTurn(this.turn.lastAt);
        this.beginUserTurn(text, at, undefined, attachments);
        return;
      }
      case "PLANNER_RESPONSE":
        this.consumePlannerResponse(step, at);
        return;
      case "GENERIC":
        this.consumeToolResult(step, at);
        return;
      case "CHECKPOINT":
        this.compactionMarker(at);
        return;
      default:
        // SYSTEM_MESSAGE（后台任务通知等）、ERROR_MESSAGE（模型格式错误后的自动重试）不展示
        return;
    }
  }

  private consumePlannerResponse(step: AgyStep, at: number) {
    this.settlePendingTools();
    this.ensureTurn(at);
    const thinking = str(step.thinking)?.trim();
    if (thinking) {
      const row: ReasoningRow = { ...this.base(at), kind: "reasoning", text: thinking, state: "complete" };
      this.put(row);
    }
    const content = str(step.content)?.trim();
    if (content) {
      const row: AssistantTextRow = { ...this.base(at), kind: "assistantText", text: content, state: "complete" };
      this.put(row);
    }
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls.filter(isRecord) : [];
    calls.forEach((call, index) => {
      const id = `step-${step.step_index ?? this.nextRowId}-${index}`;
      const { toolName, input } = projectAgyTool(str(call.name) ?? "tool", isRecord(call.args) ? call.args : {});
      this.createToolRow(id, toolName, input, at, "running");
      this.pendingTools.push(id);
    });
  }

  private consumeToolResult(step: AgyStep, at: number) {
    const id = this.pendingTools.shift();
    const rowId = id === undefined ? undefined : this.toolRows.get(id);
    if (rowId === undefined) return;
    const failed = step.status === "ERROR";
    const text = truncate(toolOutputText(step.content));
    this.ensureTurn(at);
    this.patch<ToolCallRow>(rowId, (row) => ({
      ...row,
      status: failed ? "error" : "success",
      output: { text },
      ...(failed ? { error: { code: "tool_error", message: str(step.error) ?? text } } : {}),
      endedAt: at,
    }));
  }

  /** 有些工具（如 grep_search）的结果不记进 transcript：下一次模型回复时视为已完成。 */
  private settlePendingTools() {
    for (const id of this.pendingTools) {
      const rowId = this.toolRows.get(id);
      if (rowId !== undefined) this.patch<ToolCallRow>(rowId, (row) => ({ ...row, status: "success" }));
    }
    this.pendingTools = [];
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

  // ───────────────────────── 实时流 ─────────────────────────

  /** stream-json 的 step_update。用户输入已在本地写过气泡，这里跳过。 */
  streamStep(update: JsonRecord, at: number) {
    const index = typeof update.step_index === "number" ? update.step_index : -1;
    const done = update.state === "DONE";
    switch (update.step_type) {
      case "agent_response":
        this.streamDelta(this.streamThinking, index, "reasoning", str(update.thinking_delta), done, at);
        this.streamDelta(this.streamText, index, "assistantText", str(update.text_delta), done, at);
        break;
      case "tool":
        this.streamTool(update, index, at);
        break;
      case "checkpoint":
        if (done) this.compactionMarker(at);
        break;
      default:
        return;
    }
    if (this.turn) this.turn.lastAt = at;
  }

  private streamDelta(
    rows: Map<number, number>,
    index: number,
    kind: "assistantText" | "reasoning",
    delta: string | undefined,
    done: boolean,
    at: number,
  ) {
    let rowId = rows.get(index);
    if (rowId === undefined && delta) {
      this.ensureTurn(at);
      const row: AssistantTextRow | ReasoningRow =
        kind === "assistantText"
          ? { ...this.base(at), kind, text: "", state: "streaming" }
          : { ...this.base(at), kind, text: "", state: "streaming" };
      this.put(row);
      rowId = row.rowId;
      rows.set(index, rowId);
    }
    if (rowId === undefined) return;
    if (delta) this.append(rowId, "text", delta);
    if (done) {
      this.patch<AssistantTextRow | ReasoningRow>(rowId, (row) => ({
        ...row,
        text: row.text.trimEnd(),
        state: "complete",
        ...(kind === "reasoning" ? { durationMs: Math.max(0, at - row.createdAt) } : {}),
      }));
    }
  }

  private streamTool(update: JsonRecord, index: number, at: number) {
    const info = isRecord(update.tool_info) ? update.tool_info : {};
    const name = str(info.name) ?? str(update.tool_name) ?? "tool";
    const { toolName, input } = projectAgyTool(name, isRecord(info.parameters) ? info.parameters : {});
    const id = `step-${index}`;
    let rowId = this.toolRows.get(id);
    if (rowId === undefined) {
      this.ensureTurn(at);
      rowId = this.createToolRow(id, toolName, input, at, "running");
    }
    const output = str(info.output);
    const status: ToolCallRow["status"] | undefined =
      update.state === "DONE" ? "success" : update.state === "ERROR" ? "error" : update.state === "CANCELED" ? "cancelled" : undefined;
    const error = str(update.error_message);
    this.patch<ToolCallRow>(rowId, (row) => ({
      ...row,
      toolName,
      input,
      inputText: JSON.stringify(input),
      ...(output ? { output: { text: truncate(output) } } : {}),
      ...(status ? { status, endedAt: at } : {}),
      ...(status === "error" ? { error: { code: "tool_error", message: error ?? output ?? "工具执行失败" } } : {}),
    }));
  }

  /** 一轮结束后的提示（出错、被拒绝的操作）。 */
  notice(text: string, at: number, failed = false) {
    this.ensureTurn(at);
    const row: AssistantTextRow = { ...this.base(at), kind: "assistantText", text, state: failed ? "failed" : "complete" };
    this.put(row);
  }
}

export function projectAgyHistory(steps: readonly AgyStep[]): AgyRowProjector {
  const projector = new AgyRowProjector();
  let lastAt = 0;
  for (const step of steps) {
    projector.consumeStep(step);
    lastAt = Math.max(lastAt, parseTime(step.created_at, 0));
  }
  projector.closeTurn(lastAt || Date.now());
  projector.drain();
  return projector;
}
