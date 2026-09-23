// Codex ThreadItem → ZCode v4 ConversationRow。
// 历史（thread/turns/list）与实时（item/started、item/completed 及各种 delta 通知）共用。
// 工具名映射到 ZCode 已认识的工具族，卡片就能直接复用：
//   commandExecution → Bash / Read / Grep；fileChange → ApplyPatch（file_diffs 展示）；
//   mcpToolCall → mcp__server__tool；webSearch → WebSearch；计划更新 → TodoWrite。
import type {
  AssistantTextRow,
  ReasoningRow,
  TimelineMarkerRow,
  ToolCallRow,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import {
  imageAttachment,
  imageInputAttachments,
  isRecord,
  RowProjectorBase,
  truncate,
  type JsonRecord,
  type UserAttachment,
} from "../rowProjectorBase.js";
import type { ImageInput } from "../../../shared/types.js";

export type CodexItem = JsonRecord & { type: string; id: string };

export interface CodexTurn {
  id: string;
  items: CodexItem[];
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: { message?: string } | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
}

// ───────────────────────── 工具函数 ─────────────────────────

/** `/bin/zsh -lc "printf 'hi' > a.txt"` → `printf 'hi' > a.txt` */
export function unwrapShellCommand(command: string): string {
  const match = /^\/bin\/(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/.exec(command.trim());
  if (!match) return command;
  const body = match[1]!.trim();
  if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) {
    return body.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  if (body.length >= 2 && body.startsWith("'") && body.endsWith("'")) {
    return body.slice(1, -1).replace(/'\\''/g, "'");
  }
  return body;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** 把 codex 的 unified diff 片段（只有 @@ 段，没有文件头）解析成 ZCode file_diff 的 structuredPatch。 */
export function parseUnifiedDiff(diff: string, kind: string): { hunks: Hunk[]; additions: number; deletions: number } {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: Hunk[] = [];
  let additions = 0;
  let deletions = 0;
  if (!diff.includes("@@")) {
    // 新建/删除文件时 diff 可能直接是文件全文
    const sign = kind === "delete" ? "-" : "+";
    const body = lines.map((line) => `${sign}${line}`);
    if (sign === "+") additions = lines.length;
    else deletions = lines.length;
    hunks.push(
      sign === "+"
        ? { oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: body }
        : { oldStart: 1, oldLines: lines.length, newStart: 0, newLines: 0, lines: body },
    );
    return { hunks, additions, deletions };
  }
  let current: Hunk | null = null;
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
    current.lines.push(line);
  }
  return { hunks, additions, deletions };
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;

/** localImage 只记录了本地路径：读出来转成 data URL；文件已不在或过大时退回文字占位。 */
function localImageAttachment(path: string): UserAttachment | null {
  try {
    if (statSync(path).size > MAX_LOCAL_IMAGE_BYTES) return null;
    const mime = IMAGE_MIME[extname(path).toLowerCase()] ?? "image/png";
    return imageAttachment(mime, readFileSync(path).toString("base64"), path.split("/").at(-1));
  } catch {
    return null;
  }
}

function userInputParts(content: unknown): { text: string; attachments: UserAttachment[] } {
  if (!Array.isArray(content)) return { text: "", attachments: [] };
  const parts: string[] = [];
  const attachments: UserAttachment[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part.type === "image" && typeof part.url === "string") {
      attachments.push({ ref: part.url, fileName: "图片", mime: /^data:([^;,]+)/.exec(part.url)?.[1] ?? "image/*", bytes: 0 });
    } else if (part.type === "localImage" && typeof part.path === "string") {
      const image = localImageAttachment(part.path);
      if (image) attachments.push(image);
      else parts.push(`[图片 ${part.path}]`);
    } else if (part.type === "mention" || part.type === "skill") {
      if (typeof part.name === "string") parts.push(`@${part.name}`);
    }
  }
  return { text: parts.join("\n"), attachments };
}

function mcpResultText(result: unknown, error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message;
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  return result.content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

type ToolProjection = Pick<ToolCallRow, "toolName" | "status"> & {
  input: Record<string, unknown>;
  output?: ToolCallRow["output"];
  error?: ToolCallRow["error"];
};

const TERMINAL_STATUS: Record<string, ToolCallRow["status"]> = {
  inProgress: "running",
  completed: "success",
  failed: "error",
  declined: "cancelled",
};

function statusOf(item: CodexItem): ToolCallRow["status"] {
  return TERMINAL_STATUS[String(item.status)] ?? "running";
}

/** 把一个工具类 item 投影成工具卡片；返回 null 表示这个 item 不是工具。 */
function projectTool(item: CodexItem): ToolProjection | null {
  switch (item.type) {
    case "commandExecution": {
      const command = unwrapShellCommand(String(item.command ?? ""));
      const output = typeof item.aggregatedOutput === "string" ? truncate(item.aggregatedOutput) : "";
      let status = statusOf(item);
      if (status === "success" && typeof item.exitCode === "number" && item.exitCode !== 0) status = "error";
      const actions = Array.isArray(item.commandActions) ? item.commandActions.filter(isRecord) : [];
      const only = actions.length === 1 ? actions[0]! : null;
      const base = {
        status,
        output: { text: output },
        ...(status === "error" ? { error: { code: "exit_code", message: output || `退出码 ${String(item.exitCode)}` } } : {}),
      };
      if (only?.type === "read" && typeof only.path === "string") {
        return { ...base, toolName: "Read", input: { file_path: only.path, command } };
      }
      if (only?.type === "search") {
        return {
          ...base,
          toolName: "Grep",
          input: { pattern: only.query ?? command, ...(only.path ? { path: only.path } : {}), command },
        };
      }
      return { ...base, toolName: "Bash", input: { command, ...(item.cwd ? { cwd: item.cwd } : {}) } };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
      const inputChanges: Record<string, unknown> = {};
      const files = changes.map((change) => {
        const path = String(change.path ?? "");
        const kind = isRecord(change.kind) ? String(change.kind.type ?? "update") : "update";
        const diff = String(change.diff ?? "");
        inputChanges[path] = { type: kind, unified_diff: diff };
        const parsed = parseUnifiedDiff(diff, kind);
        return {
          kind: "file_diff",
          filePath: path,
          additions: parsed.additions,
          deletions: parsed.deletions,
          structuredPatch: parsed.hunks,
        };
      });
      const summary = files.map((file) => `${file.filePath} (+${file.additions} -${file.deletions})`).join("\n");
      return {
        toolName: "ApplyPatch",
        status: statusOf(item),
        input: { changes: inputChanges },
        output: {
          text: summary,
          // ZCode 的 fileSummaries 支持 file_diffs（多文件）展示；行不做 schema 校验，直接透传
          display: { kind: "file_diffs", files } as unknown as NonNullable<ToolCallRow["output"]>["display"],
        },
      };
    }
    case "mcpToolCall": {
      const text = truncate(mcpResultText(item.result, item.error));
      const status = item.error ? "error" : statusOf(item);
      return {
        toolName: `mcp__${String(item.server ?? "mcp")}__${String(item.tool ?? "tool")}`,
        status,
        input: isRecord(item.arguments) ? item.arguments : { arguments: item.arguments },
        output: { text },
        ...(status === "error" ? { error: { code: "mcp_error", message: text || "调用失败" } } : {}),
      };
    }
    case "dynamicToolCall": {
      const items = Array.isArray(item.contentItems) ? item.contentItems.filter(isRecord) : [];
      const text = items.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
      return {
        toolName: String(item.tool ?? "tool"),
        status: item.success === false ? "error" : statusOf(item),
        input: isRecord(item.arguments) ? item.arguments : {},
        output: { text: truncate(text) },
      };
    }
    case "webSearch":
      return {
        toolName: "WebSearch",
        status: "success",
        input: { query: String(item.query ?? "") },
      };
    case "imageView":
      return { toolName: "Read", status: "success", input: { file_path: String(item.path ?? "") } };
    case "collabAgentToolCall":
      return {
        toolName: "Agent",
        status: statusOf(item),
        input: { prompt: String(item.prompt ?? ""), description: String(item.tool ?? "agent") },
      };
    default:
      return null;
  }
}

// ───────────────────────── 投影器 ─────────────────────────

export class CodexRowProjector extends RowProjectorBase {
  /** item id → 行 id（正文/思考/工具共用） */
  private readonly itemRows = new Map<string, number>();
  /** 实时发送时已在本地写过用户气泡，跳过服务端回显的第一条 userMessage。 */
  private skipNextUserEcho = false;
  private planRowId: number | null = null;

  beginLocalTurn(text: string, at: number, images?: readonly ImageInput[]) {
    this.beginUserTurn(text, at, undefined, imageInputAttachments(images));
    this.skipNextUserEcho = true;
  }

  protected override onTurnClosed() {
    this.planRowId = null;
    this.skipNextUserEcho = false;
  }

  /** 历史中的一整轮。 */
  consumeTurn(turn: CodexTurn) {
    const startedAt = (turn.startedAt ?? 0) * 1000;
    const completedAt = (turn.completedAt ?? turn.startedAt ?? 0) * 1000;
    const hasUser = turn.items.some((item) => item.type === "userMessage");
    if (!hasUser) this.ensureTurnAt(startedAt || completedAt);
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const { text, attachments } = userInputParts(item.content);
        if (text.trim() || attachments.length) this.beginUserTurn(text, startedAt || completedAt, turn.id, attachments);
        continue;
      }
      this.itemCompleted(item, completedAt || startedAt);
    }
    this.finishTurn(turn, completedAt || Date.now());
  }

  /** 结束当前轮：用 codex 给出的状态和耗时。 */
  finishTurn(turn: Pick<CodexTurn, "status" | "durationMs" | "error">, at: number) {
    if (turn.status === "interrupted") this.markInterrupted();
    if (turn.status === "failed" && turn.error?.message && this.turn) {
      const row: AssistantTextRow = {
        ...this.base(at),
        kind: "assistantText",
        text: turn.error.message,
        state: "failed",
      };
      this.put(row);
    }
    const state: TurnHeaderRow["state"] | undefined =
      turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "completedInterrupted" : undefined;
    this.closeTurn(at, state, turn.durationMs ?? undefined);
  }

  private ensureTurnAt(at: number) {
    this.ensureTurn(at);
  }

  itemStarted(item: CodexItem, at: number) {
    if (item.type === "userMessage") {
      if (this.skipNextUserEcho) {
        this.skipNextUserEcho = false;
        return;
      }
      const { text, attachments } = userInputParts(item.content);
      if (text.trim() || attachments.length) this.beginUserTurn(text, at, undefined, attachments);
      return;
    }
    this.ensureTurn(at);
    if (this.itemRows.has(item.id)) return;
    if (item.type === "agentMessage") {
      const row: AssistantTextRow = {
        ...this.base(at),
        kind: "assistantText",
        text: typeof item.text === "string" ? item.text : "",
        state: "streaming",
        assistantResponseId: item.id,
      };
      this.itemRows.set(item.id, row.rowId);
      this.put(row);
      return;
    }
    if (item.type === "reasoning") {
      const row: ReasoningRow = {
        ...this.base(at),
        kind: "reasoning",
        text: "",
        state: "streaming",
        assistantResponseId: item.id,
      };
      this.itemRows.set(item.id, row.rowId);
      this.put(row);
      return;
    }
    const tool = projectTool(item);
    if (tool) {
      const rowId = this.createToolRow(item.id, tool.toolName, tool.input, at, "running");
      this.itemRows.set(item.id, rowId);
    }
  }

  itemCompleted(item: CodexItem, at: number) {
    if (item.type === "userMessage") {
      // 回显已在 itemStarted 处理；历史里由 consumeTurn 处理
      return;
    }
    this.ensureTurn(at);
    const existing = this.itemRows.get(item.id);
    switch (item.type) {
      case "agentMessage":
      case "plan": {
        const text = typeof item.text === "string" ? item.text : "";
        if (existing !== undefined) {
          this.patch<AssistantTextRow>(existing, (row) => ({ ...row, text: text || row.text, state: "complete" }));
        } else if (text.trim()) {
          const row: AssistantTextRow = {
            ...this.base(at),
            kind: "assistantText",
            text,
            state: "complete",
            assistantResponseId: item.id,
          };
          this.itemRows.set(item.id, row.rowId);
          this.put(row);
        }
        return;
      }
      case "reasoning": {
        const summary = Array.isArray(item.summary) ? item.summary.filter((s) => typeof s === "string") : [];
        const text = summary.join("\n\n");
        if (existing !== undefined) {
          this.patch<ReasoningRow>(existing, (row) => ({
            ...row,
            text: text || row.text,
            state: "complete",
            durationMs: Math.max(0, at - row.createdAt),
          }));
        } else if (text.trim()) {
          const row: ReasoningRow = {
            ...this.base(at),
            kind: "reasoning",
            text,
            state: "complete",
            assistantResponseId: item.id,
          };
          this.itemRows.set(item.id, row.rowId);
          this.put(row);
        }
        return;
      }
      case "contextCompaction": {
        const row: TimelineMarkerRow = {
          ...this.base(at),
          kind: "timelineMarker",
          lane: "assistantWork",
          marker: { type: "compact", origin: "auto", status: "success" },
        };
        this.put(row);
        return;
      }
      default:
        break;
    }
    const tool = projectTool(item);
    if (!tool) return;
    const rowId = existing ?? this.createToolRow(item.id, tool.toolName, tool.input, at, tool.status);
    this.itemRows.set(item.id, rowId);
    this.patch<ToolCallRow>(rowId, (row) => {
      const { approvalInteractionId: _approval, ...rest } = row;
      // 用户在审批卡片上拒绝过的，保持“已取消”
      const status = row.status === "cancelled" && tool.status !== "success" ? "cancelled" : tool.status;
      return {
        ...rest,
        toolName: tool.toolName,
        input: tool.input,
        inputText: JSON.stringify(tool.input),
        status,
        ...(tool.output ? { output: tool.output } : {}),
        ...(tool.error && status === "error" ? { error: tool.error } : {}),
        endedAt: at,
      };
    });
  }

  appendText(itemId: string, delta: string, separator = "") {
    const rowId = this.itemRows.get(itemId);
    if (rowId === undefined) return;
    const row = this.rows.get(rowId);
    const needsSeparator = separator && row && "text" in row && typeof row.text === "string" && row.text.length > 0;
    this.append(rowId, "text", needsSeparator ? separator + delta : delta);
    if (this.turn) this.turn.lastAt = Date.now();
  }

  /** 命令执行的实时输出：整行替换（主进程按 16ms 合批推送）。 */
  appendToolOutput(itemId: string, delta: string) {
    const rowId = this.itemRows.get(itemId);
    if (rowId === undefined) return;
    this.patch<ToolCallRow>(rowId, (row) => ({
      ...row,
      output: { text: truncate((row.output?.text ?? "") + delta) },
    }));
  }

  /** turn/plan/updated → TodoWrite 卡片（每轮一张，原地更新）。 */
  updatePlan(plan: unknown, at: number) {
    if (!Array.isArray(plan)) return;
    const todos = plan.filter(isRecord).map((step) => ({
      content: String(step.step ?? ""),
      status: step.status === "inProgress" ? "in_progress" : step.status === "completed" ? "completed" : "pending",
    }));
    const input = { todos };
    this.ensureTurn(at);
    if (this.planRowId === null) {
      this.planRowId = this.createToolRow(`plan-${this.turn?.turnId ?? at}`, "TodoWrite", input, at, "success");
    } else {
      this.patch<ToolCallRow>(this.planRowId, (row) => ({ ...row, input, inputText: JSON.stringify(input) }));
    }
  }

  hasItem(itemId: string): boolean {
    return this.itemRows.has(itemId);
  }

  /** 审批时，工具行按 item id 查找（codex 的 toolCallId 就是 item id）。 */
  itemInput(itemId: string): Record<string, unknown> | undefined {
    const rowId = this.itemRows.get(itemId);
    const row = rowId === undefined ? undefined : this.rows.get(rowId);
    return row && row.kind === "toolCall" && isRecord(row.input) ? row.input : undefined;
  }
}

export function projectCodexTurns(turns: readonly CodexTurn[]): CodexRowProjector {
  const projector = new CodexRowProjector();
  for (const turn of turns) projector.consumeTurn(turn);
  projector.drain();
  return projector;
}
