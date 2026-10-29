// 远程历史补页：保留期间收到的实时行，并阻止关闭/重开视图后的迟到响应回写。
import type { ConversationRow } from "@hcode/shared/types";
import type { AppState, Conversation } from "./appStore";
import { hcode, remoteBridge } from "../bridge";

export async function loadRemoteHistory(viewId: string, get: () => AppState, patch: (id: string, update: Partial<Conversation>) => void, complete = false): Promise<void> {
  const initial = get().conversations[viewId];
  if (!initial || initial.refreshing || initial.earlierRowsLoading || (!complete && !initial.earlierRows)) return;
  const ref = initial.earlierRows?.ref ?? (initial.sessionId ? { id: initial.sessionId, agent: initial.agent, projectPath: initial.projectPath } : undefined);
  if (!ref) return;
  const token = Symbol("remote-history");
  const current = () => get().conversations[viewId]?.historyRequest === token;
  patch(viewId, { historyRequest: token, earlierRowsLoading: true, earlierRowsError: undefined });
  try {
    const result = complete ? await hcode.invoke("sessions:load", ref, { complete: true }) : await remoteBridge!.loadEarlier(ref, initial.earlierRows!.beforeRowId);
    if (!get().conversations[viewId] || !current()) return;
    patch(viewId, { rows: mergeHistoryRows(result.rows, get().conversations[viewId]!.rows), earlierRows: result.earlierRows, earlierRowsLoading: false, historyRequest: undefined });
  } catch (error) {
    if (current()) patch(viewId, { earlierRowsLoading: false, historyRequest: undefined, earlierRowsError: error instanceof Error ? error.message : String(error) });
  }
}

export function mergeHistoryRows(history: ConversationRow[], current: ConversationRow[]): ConversationRow[] {
  const rows = new Map(history.map(row => [row.rowId, row]));
  for (const row of current) rows.set(row.rowId, row);
  return [...rows.values()].sort((left, right) => left.rowId - right.rowId);
}
