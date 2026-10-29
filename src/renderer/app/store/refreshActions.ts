// 手动刷新保留已有内容；请求身份避免关闭/重开后的迟到响应覆盖新视图。
import type { AppState, Conversation } from "./appStore";
import { hcode, remoteBridge } from "../bridge";
import { toast } from "@/components/ui/toast.js";

type SetState = (update: Partial<AppState>) => void;
type PatchConversation = (id: string, update: Partial<Conversation>) => void;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 强制重新建立 CLI 索引，再更新已展开的列表；失败保留当前列表。 */
export async function refreshSessionList(get: () => AppState, set: SetState): Promise<void> {
  if (get().sessionListRefreshing) return;
  set({ sessionListRefreshing: true });
  try {
    const projects = await hcode.invoke("projects:list", true);
    set({ projects });
    await Promise.all(projects.filter(project => get().expanded[project.path]).map(project => get().loadSessions(project.path)));
  } catch (error) {
    toast(`刷新会话列表失败：${messageOf(error)}`, { variant: "warning" });
  } finally { set({ sessionListRefreshing: false }); }
}

/** 活跃远程会话由快照协调器处理序号；历史只重读已加载范围，保留期间到达的增量。 */
export async function refreshConversation(viewId: string, get: () => AppState, patch: PatchConversation): Promise<void> {
  const initial = get().conversations[viewId];
  if (!initial || initial.loading || initial.refreshing || initial.earlierRowsLoading || (!initial.sessionId && !initial.sessionKey)) return;
  const token = Symbol("conversation-refresh");
  const current = () => get().conversations[viewId]?.refreshRequest === token;
  patch(viewId, { refreshing: true, refreshError: undefined, refreshRequest: token });
  try {
    if (remoteBridge && initial.sessionKey) {
      await remoteBridge.refreshSession(initial.sessionKey);
    } else {
      if (!initial.sessionId) throw new Error("会话尚未保存，请稍后刷新");
      const ref = { agent: initial.agent, id: initial.sessionId, projectPath: initial.projectPath };
      const result = remoteBridge ? await remoteBridge.refreshHistory(ref, initial.rows[0]?.rowId) : await hcode.invoke("sessions:load", ref);
      if (!current()) return;
      const before = new Map(initial.rows.map(row => [row.rowId, row]));
      const rows = new Map(result.rows.map(row => [row.rowId, row]));
      for (const row of get().conversations[viewId]!.rows) if (before.get(row.rowId) !== row) rows.set(row.rowId, row);
      patch(viewId, { rows: [...rows.values()].sort((left, right) => left.rowId - right.rowId), earlierRows: result.earlierRows });
    }
    if (current()) patch(viewId, { refreshing: false, refreshRequest: undefined });
  } catch (error) {
    if (current()) patch(viewId, { refreshing: false, refreshRequest: undefined, refreshError: messageOf(error) });
  }
}
