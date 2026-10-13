// 通过真实界面状态动作验证导航；只替换 Electron IPC、通知和浏览器持久化边界。
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@hcode/shared/types';
import type { CollaborationPresentation } from '@hcode/shared/collaborationPresentation';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../bridge', () => ({ hcode: { invoke, on: vi.fn() } }));
vi.mock('@/components/ui/toast.js', () => ({ toast: vi.fn() }));
import { openPresentation, takeoverPresentation } from './openPresentation';
import { useWorkMode } from '../composer/workMode';
import { bindCollaborationSource } from './sourceConversation';
import type { CollaborationSnapshot } from '@hcode/shared/collaboration';
import { useAppStore } from '../store/appStore';
import { useUiStore } from '../store/uiStore';

const entry: CollaborationPresentation = { id: 'run', runId: 'run', createdAt: 1, projectPath: '/source', objective: '核对表单', status: '汇总已完成', tasks: [], source: { agent: 'codex', sessionKey: 'source-key', nativeSessionId: 'source-id' } };
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  invoke.mockReset();
  invoke.mockResolvedValue({ rows: [] });
  useAppStore.setState({ settings: DEFAULT_SETTINGS, conversations: {}, activeViewId: null, sessions: {}, models: {} });
  useUiStore.setState({ sidePanel: null, returnPanel: null });
});
afterEach(() => vi.unstubAllGlobals());

it('任务组打开真实源线程和指定 Run，导航不发送模型回合', async () => {
  await openPresentation(entry);
  expect(invoke).toHaveBeenCalledWith('sessions:load', { id: 'source-id', agent: 'codex', projectPath: '/source' });
  expect(useUiStore.getState().sidePanel).toEqual({ type: 'collaboration', viewId: 'source-id', intent: 'records', runId: 'run' });
  expect(invoke.mock.calls.some(call => call[0] === 'chat:send')).toBe(false);
});
it('加载期间切换了项目后，不把旧 Run 面板带入新项目', async () => {
  let loaded!: (result: { rows: [] }) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { loaded = resolve; }));
  const opening = openPresentation(entry);
  useAppStore.getState().newChat('/other');
  const otherView = useAppStore.getState().activeViewId;
  loaded({ rows: [] });
  await expect(opening).rejects.toThrow('导航已变化');
  expect(useAppStore.getState().activeViewId).toBe(otherView);
  expect(useUiStore.getState().sidePanel).toBeNull();
});
it('来源身份缺失时明确失败，不能创建替代会话', async () => {
  await expect(openPresentation({ ...entry, source: { ...entry.source, nativeSessionId: undefined } })).rejects.toThrow('尚未建立');
  expect(invoke).not.toHaveBeenCalled();
  expect(useAppStore.getState().conversations).toEqual({});
});
it('续跑绑定原会话时核对项目，不改写同原生 ID 的其他项目视图', async () => {
  await openPresentation(entry);
  const original = useAppStore.getState().conversations['source-id']!;
  const other = { ...original, viewId: 'other', projectPath: '/other', sessionKey: 'other-key' };
  useAppStore.setState({ conversations: { 'source-id': original, other } });
  bindCollaborationSource({ params: { initiator: { agent: 'codex', sessionKey: 'new-source-key', projectPath: '/source', resumeSessionId: 'source-id' } }, tasks: [] } as unknown as CollaborationSnapshot);
  expect(useAppStore.getState().conversations['source-id']!.sessionKey).toBe('new-source-key');
  expect(useAppStore.getState().conversations.other).toEqual(other);
});
it('确认接管后返回普通对话；停止未确认时保留当前工作方式，不能发送消息', async () => {
  await openPresentation(entry);
  useWorkMode.getState().select('source-id', 'collaboration');
  const run = { id: 'run', createdAt: 1, params: { initiator: { agent: 'codex', sessionKey: 'source-key', projectPath: '/source', resumeSessionId: 'source-id' }, objective: '核对' }, tasks: [], deliveries: [], status: 'paused', stage: 'finished' } as unknown as CollaborationSnapshot;
  invoke.mockRejectedValueOnce(new Error('原生停止未确认'));
  await expect(takeoverPresentation(run)).rejects.toThrow('未确认');
  expect(useWorkMode.getState().views['source-id']?.mode).toBe('collaboration');
  await takeoverPresentation(run);
  expect(useWorkMode.getState().views['source-id']?.mode).toBe('chat');
  expect(useUiStore.getState().sidePanel).toBeNull();
  expect(invoke.mock.calls.some(call => call[0] === 'chat:send')).toBe(false);
});
it('证据预览返回保留指定 Run，跨会话切换撤销旧返回目标', async () => {
  await openPresentation(entry);
  useUiStore.getState().setSidePanel({ type: 'file', viewId: 'source-id', source: { type: 'file', title: '证据', path: '/source/evidence.ts' } });
  expect(useUiStore.getState().returnPanel).toMatchObject({ runId: 'run', viewId: 'source-id' });
  useUiStore.getState().setSidePanel({ type: 'file', viewId: 'other-id', source: { type: 'file', title: '其他证据', path: '/other/evidence.ts' } });
  expect(useUiStore.getState().returnPanel).toBeNull();
});
