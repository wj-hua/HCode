// 真实 ClaudeSession 消费原生 SDK 流；只替换外部 SDK 传输，建议不能被当作新回合或正文。
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', async original => ({ ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(), query: sdk.query }));
import { ClaudeSession } from '../claude/claudeSession.js';
import type { ChatPromptSuggestionEvent, ChatStateEvent } from '../../../shared/types.js';

function nativeStream() {
  const queued: SDKMessage[] = [];
  let waiting: ((value: IteratorResult<SDKMessage>) => void) | undefined;
  let ended = false;
  const stream = {
    push(message: SDKMessage) { if (waiting) { const receive = waiting; waiting = undefined; receive({ value: message, done: false }); } else queued.push(message); },
    close() { ended = true; waiting?.({ value: undefined, done: true }); },
    getContextUsage: async () => ({ totalTokens: 1, maxTokens: 100 }),
    interrupt: async () => {}, stopTask: vi.fn(async (_id: string) => {}), setPermissionMode: async () => {},
    [Symbol.asyncIterator]() { return { next: async (): Promise<IteratorResult<SDKMessage>> => queued.length ? { value: queued.shift()!, done: false } : ended ? { value: undefined, done: true } : new Promise(resolve => { waiting = resolve; }) }; },
  };
  return stream;
}
const sessions: ClaudeSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); sdk.query.mockReset(); });
function fixture(research = false) {
  const stream = nativeStream();
  sdk.query.mockReturnValue(stream as unknown as Query);
  const suggestions: ChatPromptSuggestionEvent[] = [], states: ChatStateEvent[] = [], outcomes: unknown[] = [];
  const session = new ClaudeSession({ claudePath: '/fixture/claude', env: {}, emitRows: () => {}, emitState: event => states.push(event), emitPromptSuggestion: event => suggestions.push(event), emitPermission: () => {}, emitPermissionResolved: () => {}, onSessionId: () => {}, onQuotaChanged: () => {}, onCommandsChanged: () => {}, emitTurnOutcome: event => outcomes.push(event) }, { key: 'source', projectPath: '/project', resumeSessionId: 'native', permissionMode: 'default' });
  sessions.push(session);
  return { session, stream, suggestions, states, outcomes, start: async () => { if (research) await session.configureResearch({ root: '/project' }); session.send('完成当前任务', [], [], 'turn-one'); } };
}
function result(success = true): SDKMessage {
  return { type: 'result', subtype: 'success', session_id: 'native', uuid: randomUUID(), stop_reason: 'end_turn', result: success ? 'DONE' : 'API failed', is_error: !success,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, permission_denials: [], duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0 } as unknown as SDKMessage;
}
const suggestion = (text = '请继续下一步', sessionId = 'native'): SDKMessage => ({ type: 'prompt_suggestion', suggestion: text, session_id: sessionId, uuid: randomUUID() });

it('原生后台事件在回合结束后仍发布详情，进度和完成结果不依赖下一次发送', async () => {
  const data = fixture(); await data.start();
  expect(data.states[0]?.state).toBe('running');
  const base = { type: 'system' as const, uuid: randomUUID(), session_id: 'native' };
  data.stream.push({ ...base, subtype: 'background_tasks_changed' as const, tasks: [{ task_id: 'test', task_type: 'local_bash', description: '全量测试' }] });
  data.stream.push(result());
  await vi.waitFor(() => expect(data.states.at(-1)).toMatchObject({ state: 'idle', backgroundTasks: 1, backgroundTaskDetails: [{ id: 'test', status: 'running' }] }));
  data.stream.push({ ...base, subtype: 'task_progress' as const, task_id: 'test', description: '全量测试', summary: 'UI 测试中', usage: { duration_ms: 3000, total_tokens: 0, tool_uses: 1 } });
  await vi.waitFor(() => expect(data.states.at(-1)?.backgroundTaskDetails?.[0]?.summary).toBe('UI 测试中'));
  data.stream.push({ ...base, subtype: 'background_tasks_changed' as const, tasks: [] });
  data.stream.push({ ...base, subtype: 'task_notification' as const, task_id: 'test', status: 'completed' as const, output_file: '/tmp/test.log', summary: '全部通过' });
  await vi.waitFor(() => expect(data.states.at(-1)).toMatchObject({ state: 'idle', backgroundTaskDetails: [{ id: 'test', status: 'completed', summary: '全部通过' }] }));
  expect(data.states.at(-1)?.backgroundTasks).toBeUndefined();
  expect(data.session.hasBackgroundTasks).toBe(false);
  expect(sdk.query).toHaveBeenCalledTimes(1);
});

it('单独停止活动后台任务并等待原生终态，拒绝未知或已结束任务', async () => {
  const data = fixture(); await data.start();
  const base = { type: 'system' as const, uuid: randomUUID(), session_id: 'native' };
  data.stream.push({ ...base, subtype: 'background_tasks_changed' as const, tasks: [{ task_id: 'monitor', task_type: 'local_bash', description: '监视进度' }, { task_id: 'other', task_type: 'local_bash', description: '测试' }] });
  await vi.waitFor(() => expect(data.session.hasBackgroundTasks).toBe(true));
  await data.session.stopBackgroundTask('monitor');
  expect(data.stream.stopTask).toHaveBeenCalledWith('monitor');
  expect(data.states.at(-1)?.backgroundTaskDetails?.find(task => task.id === 'monitor')?.status).toBe('running');
  await expect(data.session.stopBackgroundTask('unknown')).rejects.toThrow('不存在或已结束');
  data.stream.push({ ...base, subtype: 'background_tasks_changed' as const, tasks: [{ task_id: 'other', task_type: 'local_bash', description: '测试' }] });
  data.stream.push({ ...base, subtype: 'task_notification' as const, task_id: 'monitor', status: 'stopped' as const, output_file: '', summary: '已停止' });
  await vi.waitFor(() => expect(data.states.at(-1)?.backgroundTaskDetails?.find(task => task.id === 'monitor')?.status).toBe('stopped'));
  expect(data.states.at(-1)?.backgroundTasks).toBe(1);
  await expect(data.session.stopBackgroundTask('monitor')).rejects.toThrow('不存在或已结束');
});

it('普通会话启用原生建议，result 后继续接收建议并关联原回合，不再次运行或改动终态', async () => {
  const data = fixture(); await data.start();
  expect(sdk.query.mock.calls[0]![0].options.promptSuggestions).toBe(true);
  data.stream.push(result()); await vi.waitFor(() => expect(data.outcomes).toHaveLength(1));
  data.stream.push(suggestion());
  await vi.waitFor(() => expect(data.suggestions.at(-1)).toMatchObject({ sessionKey: 'source', turnId: 'turn-one', suggestion: '请继续下一步', sessionId: 'native' }));
  expect(data.states.at(-1)!.state).toBe('idle'); expect(data.outcomes).toHaveLength(1); expect(sdk.query).toHaveBeenCalledTimes(1);
});

it('同一原生回合最多接受一条建议，错会话事件不能消耗正确建议', async () => {
  const data = fixture(); await data.start();
  data.stream.push(result()); data.stream.push(suggestion('错误会话', 'another-native')); data.stream.push(suggestion('正确建议')); data.stream.push(suggestion('重复建议'));
  await vi.waitFor(() => expect(data.suggestions.some(event => event.suggestion === '正确建议')).toBe(true));
  expect(data.suggestions.filter(event => event.suggestion)).toHaveLength(1);
});

it.each(['failed', 'cancelled', 'research', 'plan'] as const)('%s 回合不接收下一步建议', async mode => {
  const data = fixture(mode === 'research');
  if (mode === 'plan') await data.session.setPermissionMode('plan');
  await data.start();
  if (mode === 'research') expect(sdk.query.mock.calls[0]![0].options.promptSuggestions).toBe(false);
  if (mode === 'cancelled') await data.session.interrupt();
  data.stream.push(result(mode !== 'failed')); data.stream.push(suggestion());
  await vi.waitFor(() => expect(data.outcomes).toHaveLength(1));
  expect(data.suggestions.every(event => event.suggestion === null)).toBe(true);
});

it('新一轮清除旧建议，下一轮运行中到达的事件被拒绝', async () => {
  const data = fixture(); await data.start();
  data.stream.push(result()); data.stream.push(suggestion());
  await vi.waitFor(() => expect(data.suggestions.at(-1)!.suggestion).toBe('请继续下一步'));
  data.session.send('新目标', [], [], 'turn-two');
  expect(data.suggestions.at(-1)).toMatchObject({ turnId: 'turn-two', suggestion: null });
  data.stream.push(suggestion('迟到的上一轮建议')); data.stream.push(result()); data.stream.push(suggestion('本轮建议'));
  await vi.waitFor(() => expect(data.suggestions.at(-1)!.suggestion).toBe('本轮建议'));
  expect(data.suggestions.some(event => event.suggestion === '迟到的上一轮建议')).toBe(false);
});

it('上一建议未到就复用 query 时不猜回合归属，新 query 恢复建议接收', async () => {
  const data = fixture(); await data.start(); data.stream.push(result());
  await vi.waitFor(() => expect(data.outcomes).toHaveLength(1));
  data.session.send('排队的第二轮', [], [], 'turn-two');
  data.stream.push(result()); data.stream.push(suggestion('无法确认属于哪轮'));
  await vi.waitFor(() => expect(data.outcomes).toHaveLength(2));
  expect(data.suggestions.every(event => event.suggestion === null)).toBe(true);
  const next = nativeStream(); sdk.query.mockReturnValue(next as unknown as Query);
  await data.session.configureContinuation('新的普通回合');
  data.session.send('第三轮', [], [], 'turn-three'); next.push(result()); next.push(suggestion('新 query 建议'));
  await vi.waitFor(() => expect(data.suggestions.at(-1)).toMatchObject({ turnId: 'turn-three', suggestion: '新 query 建议' }));
});
