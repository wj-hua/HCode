// 子 AI 调用展示只订阅主进程记录与原生行；新调用自动打开当前源会话的右侧面板一次。
import { create } from 'zustand';
import { invocationBelongsToSource, type AgentInvocation } from '@hcode/shared/agentInvocation';
import type { ConversationRow } from '@hcode/shared/types';
import { hcode } from '../bridge';
import { useAppStore } from '../store/appStore';
import { useUiStore } from '../store/uiStore';
import { applyRowOps } from '../rows';
interface InvocationState {
  calls: Record<string, AgentInvocation>;
  rows: Record<string, ConversationRow[]>;
  accept(call: AgentInvocation): void;
}
export const useAgentInvocationStore = create<InvocationState>(set => ({
  calls: {}, rows: {},
  accept: call => set(state => {
    if (state.calls[call.id] && state.calls[call.id]!.seq > call.seq) return state;
    return { calls: { ...state.calls, [call.id]: call } };
  }),
}));
let references = 0;
let dispose: (() => void) | undefined;
export function subscribeAgentInvocations() {
  if (references++ === 0) {
    const updated = hcode.on('agentInvocation:updated', call => {
      const first = !useAgentInvocationStore.getState().calls[call.id];
      useAgentInvocationStore.getState().accept(call);
      const state = useAppStore.getState();
      const current = state.activeViewId ? state.conversations[state.activeViewId] : undefined;
      if (first && call.status === 'running' && current && invocationBelongsToSource(call, current)) useUiStore.getState().setSidePanel({ type: 'collaboration', viewId: current.viewId, intent: 'records' });
    });
    const rows = hcode.on('chat:rows', event => {
      const state = useAgentInvocationStore.getState();
      if (Object.values(state.calls).some(call => call.sessionKey === event.sessionKey)) useAgentInvocationStore.setState({ rows: { ...state.rows, [event.sessionKey]: applyRowOps(state.rows[event.sessionKey] ?? [], event.ops) } });
    });
    dispose = () => { updated(); rows(); };
  }
  return () => { if (--references === 0) { dispose?.(); dispose = undefined; } };
}
