// 两类草案共用当前会话绑定；历史原生身份优先，不创建替代线程或覆盖新输入。
import type { CollaborationStartParams } from "@hcode/shared/collaboration";
import { useAppStore } from "../store/appStore";
type Source = CollaborationStartParams["initiator"];
export function bindDraftSource(viewId: string, binding?: Source): Source {
  const current = useAppStore.getState().conversations[viewId];
  if (!current || current.runState === "running" || current.runState === "awaitingApproval" || current.queue.length) throw new Error("请先完成当前会话的活动回合和消息队列");
  const sameSource = binding && (binding.sessionKey === current.sessionKey || Boolean(current.sessionId && current.sessionId === binding.resumeSessionId));
  const sessionKey = sameSource ? binding.sessionKey : current.sessionKey ?? crypto.randomUUID();
  useAppStore.setState(state => ({ conversations: { ...state.conversations, [current.viewId]: { ...current, sessionKey } } }));
  return { agent: current.agent, projectPath: current.projectPath, permissionMode: current.permissionMode, sessionKey, ...(current.sessionId ? { resumeSessionId: current.sessionId } : {}), ...(current.model ? { model: current.model } : {}), ...(current.effort ? { effort: current.effort } : {}) };
}
export function assertDraftSource(current: Source, saved: Source) {
  if (current.agent !== saved.agent || current.sessionKey !== saved.sessionKey || current.resumeSessionId && current.resumeSessionId !== saved.resumeSessionId || current.permissionMode !== saved.permissionMode || current.model !== saved.model || current.effort !== saved.effort || current.projectPath !== saved.projectPath) throw new Error("当前会话配置与计划已不同，请重新核对计划");
}
