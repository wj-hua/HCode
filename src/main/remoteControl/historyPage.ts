// 远程历史按完整回合向前分页；不改原始记录、rowId 或桌面端的全量读取契约。
import type { SessionLoadResult, SessionRef } from "../../shared/types.js";

const HISTORY_TURNS_PER_PAGE = 3;

export function remoteHistoryPage(history: SessionLoadResult, ref: SessionRef, beforeRowId?: number): SessionLoadResult {
  if (beforeRowId !== undefined && (!Number.isSafeInteger(beforeRowId) || beforeRowId <= 0)) throw new Error("无效的历史分页位置");
  const end = beforeRowId === undefined ? history.rows.length : history.rows.findIndex(row => row.rowId >= beforeRowId);
  if (end < 0) throw new Error("历史记录已变化，请重新打开会话");
  const eligible = history.rows.slice(0, end);
  let start = eligible.length;
  let turns = 0;
  let previousTurn: string | undefined;
  for (let index = eligible.length - 1; index >= 0; index--) {
    const turnId = eligible[index]!.turnId;
    if (turnId !== previousTurn && ++turns > HISTORY_TURNS_PER_PAGE) break;
    previousTurn = turnId;
    start = index;
  }
  const rows = eligible.slice(start);
  return { ...history, rows, ...(start > 0 && rows[0] ? { earlierRows: { ref, beforeRowId: rows[0].rowId } } : {}) };
}
