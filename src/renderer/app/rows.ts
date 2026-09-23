import type { ConversationRow, RowOp } from "@hcode/shared/types";

function findIndex(rows: readonly ConversationRow[], rowId: number): number {
  // 增量几乎总是落在末尾附近，倒序查找
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.rowId === rowId) return i;
  }
  return -1;
}

/** 把主进程推来的增量操作应用到按 rowId 排序的行数组上（返回新数组）。 */
export function applyRowOps(rows: readonly ConversationRow[], ops: readonly RowOp[]): ConversationRow[] {
  let next = rows.slice();
  for (const op of ops) {
    if (op.op === "reset") {
      next = op.rows.slice();
      continue;
    }
    if (op.op === "upsert") {
      const index = findIndex(next, op.row.rowId);
      if (index >= 0) {
        next[index] = op.row;
      } else {
        let insertAt = next.length;
        while (insertAt > 0 && next[insertAt - 1]!.rowId > op.row.rowId) insertAt--;
        next.splice(insertAt, 0, op.row);
      }
      continue;
    }
    const index = findIndex(next, op.rowId);
    if (index < 0) continue;
    const row = next[index]! as ConversationRow & Record<string, unknown>;
    const current = typeof row[op.field] === "string" ? (row[op.field] as string) : "";
    next[index] = { ...row, [op.field]: current + op.text } as ConversationRow;
  }
  return next;
}
