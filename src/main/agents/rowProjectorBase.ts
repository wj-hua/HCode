// 各 CLI 投影器的公共部分：维护按 rowId 排序的 ZCode v4 行、轮次、工具行与审批状态，
// 并把变化记录成增量操作（RowOp）供主进程推给渲染进程。
import type {
  AssistantTextRow,
  ConversationRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { RowOp } from "../../shared/types.js";

export type JsonRecord = Record<string, unknown>;

const MAX_TOOL_OUTPUT_CHARS = 60_000;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTime(value: unknown, fallback: number): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…（输出过长，已截断）`
    : text;
}

export class RowProjectorBase {
  protected readonly rows = new Map<number, ConversationRow>();
  protected readonly order: number[] = [];
  protected nextRowId = 1;
  protected seq = 0;
  protected ops: RowOp[] = [];
  protected turn: { turnId: string; headerRowId: number; startedAt: number; lastAt: number } | null =
    null;
  protected readonly toolRows = new Map<string, number>();
  protected interrupted = false;
  protected turnCounter = 0;

  /** 当前全部行（按 rowId 顺序）。 */
  snapshot(): ConversationRow[] {
    return this.order.map((id) => this.rows.get(id)!).filter(Boolean);
  }

  /** 取出自上次调用以来的增量操作。 */
  drain(): RowOp[] {
    const ops = this.ops;
    this.ops = [];
    return ops;
  }

  get hasOpenTurn(): boolean {
    return this.turn !== null;
  }

  // ───────────────────────── 行的基础操作 ─────────────────────────

  protected base(at: number) {
    return {
      rowId: this.nextRowId++,
      turnId: this.turn?.turnId ?? "orphan",
      createdAt: at,
      createdAtSeq: this.seq++,
    };
  }

  protected put(row: ConversationRow) {
    if (!this.rows.has(row.rowId)) this.order.push(row.rowId);
    this.rows.set(row.rowId, row);
    this.ops.push({ op: "upsert", row });
  }

  protected patch<T extends ConversationRow>(rowId: number, update: (row: T) => T) {
    const row = this.rows.get(rowId) as T | undefined;
    if (!row) return;
    this.put(update(row));
  }

  protected append(rowId: number, field: "text" | "inputText", text: string) {
    if (!text) return;
    const row = this.rows.get(rowId) as (ConversationRow & Record<string, unknown>) | undefined;
    if (!row) return;
    const current = typeof row[field] === "string" ? (row[field] as string) : "";
    this.rows.set(rowId, { ...row, [field]: current + text } as ConversationRow);
    this.ops.push({ op: "append", rowId, field, text });
  }

  // ───────────────────────── 轮次 ─────────────────────────

  /** 开启一轮：写 turnHeader + userInput。实时发送与历史里的真实用户消息都走这里。 */
  beginUserTurn(text: string, at: number, turnId?: string) {
    this.closeTurn(at);
    this.interrupted = false;
    const id = turnId ?? `turn-${++this.turnCounter}-${at}`;
    const headerRowId = this.nextRowId;
    this.turn = { turnId: id, headerRowId, startedAt: at, lastAt: at };
    const header: TurnHeaderRow = {
      ...this.base(at),
      kind: "turnHeader",
      origin: "userInput",
      executionKind: "agent",
      state: "running",
      startedAt: at,
    };
    this.put(header);
    const input: UserInputRow = {
      ...this.base(at),
      kind: "userInput",
      origin: "realUser",
      text,
    };
    this.put(input);
  }

  protected ensureTurn(at: number) {
    if (!this.turn) this.beginSyntheticTurn(at);
    else this.turn.lastAt = Math.max(this.turn.lastAt, at);
  }

  protected beginSyntheticTurn(at: number) {
    const id = `turn-${++this.turnCounter}-${at}`;
    this.turn = { turnId: id, headerRowId: this.nextRowId, startedAt: at, lastAt: at };
    const header: TurnHeaderRow = {
      ...this.base(at),
      kind: "turnHeader",
      origin: "userInput",
      executionKind: "agent",
      state: "running",
      startedAt: at,
    };
    this.put(header);
  }

  /** 结束当前轮：收尾所有仍在流式/运行中的行。 */
  closeTurn(at: number, outcome?: TurnHeaderRow["state"], activeMs?: number) {
    const turn = this.turn;
    if (!turn) return;
    const interrupted = this.interrupted;
    const state: TurnHeaderRow["state"] =
      outcome ?? (interrupted ? "completedInterrupted" : "completedSuccess");
    for (const rowId of this.order) {
      const row = this.rows.get(rowId);
      if (!row || row.turnId !== turn.turnId) continue;
      if ((row.kind === "assistantText" || row.kind === "reasoning") && row.state === "streaming") {
        this.put({ ...row, state: interrupted ? "interrupted" : "complete" } as ConversationRow);
      } else if (
        row.kind === "toolCall" &&
        (row.status === "running" ||
          row.status === "inputStreaming" ||
          row.status === "pendingApproval")
      ) {
        this.put({ ...row, status: "cancelled", endedAt: at });
      }
    }
    const endedAt = Math.max(at, turn.lastAt);
    this.patch<TurnHeaderRow>(turn.headerRowId, (header) => ({
      ...header,
      state,
      endedAt,
      activeMs: activeMs ?? Math.max(0, endedAt - turn.startedAt),
    }));
    this.turn = null;
    this.onTurnClosed();
  }

  markInterrupted() {
    this.interrupted = true;
  }

  /** 实时会话出错时，在当前轮写一条失败提示并结束该轮。 */
  failTurn(message: string, at: number) {
    this.ensureTurn(at);
    const row: AssistantTextRow = {
      ...this.base(at),
      kind: "assistantText",
      text: message,
      state: "failed",
    };
    this.put(row);
    this.closeTurn(at, "failed");
  }

  // ───────────────────────── 审批 ─────────────────────────

  setToolPendingApproval(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    interactionId: string,
    at: number,
  ) {
    let rowId = this.toolRows.get(toolUseId);
    if (rowId === undefined) {
      this.ensureTurn(at);
      rowId = this.createToolRow(toolUseId, toolName, input, at, "pendingApproval");
    }
    this.patch<ToolCallRow>(rowId, (row) => ({
      ...row,
      status: "pendingApproval",
      input: row.input ?? input,
      approvalInteractionId: interactionId,
    }));
  }

  resolveToolApproval(toolUseId: string, allowed: boolean) {
    const rowId = this.toolRows.get(toolUseId);
    if (rowId === undefined) return;
    this.patch<ToolCallRow>(rowId, (row) => {
      const { approvalInteractionId: _approval, ...rest } = row;
      if (row.status !== "pendingApproval") return rest;
      return allowed ? { ...rest, status: "running" } : { ...rest, status: "cancelled" };
    });
  }


  /** 轮次结束时的钩子，子类清理自己的流式状态。 */
  protected onTurnClosed() {}

  protected createToolRow(
    id: string,
    name: string,
    input: Record<string, unknown> | undefined,
    at: number,
    status: ToolCallRow["status"],
  ): number {
    const row: ToolCallRow = {
      ...this.base(at),
      kind: "toolCall",
      toolCallId: id,
      toolName: name,
      status,
      inputText: input ? JSON.stringify(input) : "",
      ...(input ? { input } : {}),
      startedAt: at,
    };
    this.toolRows.set(id, row.rowId);
    this.put(row);
    return row.rowId;
  }

}
