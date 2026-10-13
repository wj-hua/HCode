// 从任务组返回其真实源会话；异步导航后复核身份，避免跨项目或用户切换后打开错误 Run。
import type { CollaborationPresentation } from '@hcode/shared/collaborationPresentation';
import { useAppStore } from '../store/appStore';
import { useUiStore } from '../store/uiStore';

export async function openPresentation(entry: CollaborationPresentation) {
  const nativeId = entry.source.nativeSessionId;
  if (!nativeId) throw new Error('来源尚未建立原生会话，请从当前会话的任务面板查看。');
  await useAppStore.getState().openSession({ id: nativeId, agent: entry.source.agent, projectPath: entry.projectPath, title: entry.objective, createdAt: entry.createdAt, updatedAt: entry.createdAt });
  const state = useAppStore.getState();
  const view = state.activeViewId ? state.conversations[state.activeViewId] : undefined;
  if (!view || view.agent !== entry.source.agent || view.projectPath !== entry.projectPath || view.sessionId !== nativeId) throw new Error('来源会话导航已变化，请重新打开任务组。');
  useUiStore.getState().setSidePanel({ type: 'collaboration', viewId: view.viewId, intent: 'records', runId: entry.runId });
}
