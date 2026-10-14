// 通过实际 store 订阅验证 IPC 进度、源会话匹配与关闭后的导航；只替换 Electron 事件边界。
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentInvocation } from '@hcode/shared/agentInvocation';
const { listeners } = vi.hoisted(() => ({ listeners: new Map<string, (value: unknown) => void>() }));
vi.mock('../bridge', () => ({ hcode: { invoke: vi.fn(), on: (name: string, listener: (value: unknown) => void) => { listeners.set(name, listener); return () => listeners.delete(name); } } }));
vi.mock('@/components/ui/toast.js', () => ({ toast: vi.fn() }));
import { useAppStore } from '../store/appStore';
import { useUiStore } from '../store/uiStore';
import { subscribeAgentInvocations, useAgentInvocationStore } from './agentInvocationStore';
let dispose: () => void;
let viewId: string;
const call: AgentInvocation = { id: 'call', seq: 1, createdAt: 1, source: { sessionKey: 'source', resumeSessionId: 'native', projectPath: '/project', agent: 'claude', permissionMode: 'bypassPermissions' }, sourceTurnId: 'turn', input: { agent: 'codex', mode: 'execute', prompt: '主 AI 自己组织的任务' }, sessionKey: 'worker', status: 'running' };
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  useAppStore.setState({ conversations: {}, activeViewId: null });
  useAppStore.getState().newChat('/project', 'claude'); viewId = useAppStore.getState().activeViewId!;
  useAppStore.setState(state => ({ conversations: { ...state.conversations, [viewId]: { ...state.conversations[viewId]!, sessionKey: 'source', sessionId: 'native' } } }));
  useUiStore.getState().setSidePanel(null); useAgentInvocationStore.setState({ calls: {}, rows: {} });
  dispose = subscribeAgentInvocations();
});
afterEach(() => { dispose(); vi.unstubAllGlobals(); });
it('模型真实调用的首个事件自动打开面板，用户输入不参与匹配；后续进度不重开已关闭面板', () => {
  listeners.get('agentInvocation:updated')!(call);
  expect(useUiStore.getState().sidePanel).toEqual({ type: 'collaboration', viewId, intent: 'records' });
  useUiStore.getState().setSidePanel(null);
  listeners.get('agentInvocation:updated')!({ ...call, seq: 2, status: 'succeeded', output: '实际结果' });
  expect(useUiStore.getState().sidePanel).toBeNull();
  expect(useAgentInvocationStore.getState().calls.call?.output).toBe('实际结果');
});
it('其他源会话或旧序号不覆盖当前展示，原生行独立保存到子会话', () => {
  listeners.get('agentInvocation:updated')!({ ...call, source: { ...call.source, sessionKey: 'other', resumeSessionId: 'other-native' } });
  expect(useUiStore.getState().sidePanel).toBeNull();
  listeners.get('chat:rows')!({ sessionKey: 'worker', ops: [{ op: 'reset', rows: [{ kind: 'assistantText', rowId: 1, turnId: 'worker-turn', text: '真实流式进度', timestamp: 1 }] }] });
  expect(useAgentInvocationStore.getState().rows.worker).toHaveLength(1);
  listeners.get('agentInvocation:updated')!({ ...call, seq: 3, status: 'failed', error: '原生错误' });
  listeners.get('agentInvocation:updated')!({ ...call, seq: 2, status: 'succeeded' });
  expect(useAgentInvocationStore.getState().calls.call?.status).toBe('failed');
});
