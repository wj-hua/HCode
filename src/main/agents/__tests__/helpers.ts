// 测试辅助：按渲染进程的方式应用增量操作，并按 kind 过滤行。
import type { ConversationRow } from "../../../shared/types.js";
import { applyRowOps } from "../../../renderer/app/rows.js";
import type { RowProjectorBase } from "../rowProjectorBase.js";

/** 模拟渲染进程：不断 drain 增量操作并应用，最后应与 snapshot() 一致。 */
export class RowsMirror {
  rows: ConversationRow[] = [];

  constructor(private readonly projector: RowProjectorBase) {}

  flush(): ConversationRow[] {
    this.rows = applyRowOps(this.rows, this.projector.drain());
    return this.rows;
  }
}

export function ofKind<K extends ConversationRow["kind"]>(
  rows: readonly ConversationRow[],
  kind: K,
): Extract<ConversationRow, { kind: K }>[] {
  return rows.filter((row): row is Extract<ConversationRow, { kind: K }> => row.kind === kind);
}

export function kinds(rows: readonly ConversationRow[]): string[] {
  return rows.map((row) => row.kind);
}
