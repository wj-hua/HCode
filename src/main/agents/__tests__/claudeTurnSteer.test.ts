// 真实 ClaudeSession 的插话状态机；只替换外部 SDK 传输，按 CLI 实测的回显 / 结果 / 中断回执顺序喂消息。
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', async original => ({ ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(), query: sdk.query }));
import { ClaudeSession } from '../claude/claudeSession.js';
import type { ChatStateEvent, ConversationRow } from '../../../shared/types.js';
import { applyRowOps } from '../../../renderer/app/rows.js';

const CANCEL_QUEUED = 'interrupt_cancel_queued_v1';

function nativeStream() {
  const queued: SDKMessage[] = [];
  let waiting: ((value: IteratorResult<SDKMessage>) => void) | undefined;
  let ended = false;
  const stream = {
    push(message: SDKMessage) { if (waiting) { const receive = waiting; waiting = undefined; receive({ value: message, done: false }); } else queued.push(message); },
    close() { ended = true; waiting?.({ value: undefined, done: true }); },
    getContextUsage: async () => ({ totalTokens: 1, maxTokens: 100 }),
    interrupt: vi.fn(async (_options?: { cancelQueued?: boolean }): Promise<{ cancelled?: string[] } | undefined> => undefined),
    setPermissionMode: async () => {},
    [Symbol.asyncIterator]() { return { next: async (): Promise<IteratorResult<SDKMessage>> => queued.length ? { value: queued.shift()!, done: false } : ended ? { value: undefined, done: true } : new Promise(resolve => { waiting = resolve; }) }; },
  };
  return stream;
}

const sessions: ClaudeSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); sdk.query.mockReset(); });

function fixture() {
  const stream = nativeStream();
  sdk.query.mockReturnValue(stream as unknown as Query);
  const states: ChatStateEvent[] = [];
  let rows: ConversationRow[] = [];
  const session = new ClaudeSession({ claudePath: '/fixture/claude', env: {}, emitRows: (_key, ops) => { rows = applyRowOps(rows, ops); }, emitState: event => states.push(event), emitPermission: () => {}, emitPermissionResolved: () => {}, onSessionId: () => {}, onQuotaChanged: () => {}, onCommandsChanged: () => {} }, { key: 'source', projectPath: '/project', resumeSessionId: 'native', permissionMode: 'default' });
  sessions.push(session);
  let input: AsyncIterator<SDKUserMessage> | undefined;
  /** 读取 HCode 写进流式输入的下一条用户消息（即发给 CLI stdin 的内容）。 */
  const nextInput = async () => {
    input ??= (sdk.query.mock.calls[0]![0].prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    return (await input.next()).value as SDKUserMessage;
  };
  const start = async (capabilities: string[] = [CANCEL_QUEUED]) => {
    session.send('跑完三条命令', [], [], 'turn-one');
    await nextInput();
    stream.push(init(capabilities));
    await vi.waitFor(() => expect(states.at(-1)?.sessionId).toBe('native'));
  };
  return { session, stream, states, rows: () => rows, nextInput, start };
}

const init = (capabilities: string[]): SDKMessage => ({ type: 'system', subtype: 'init', session_id: 'native', uuid: randomUUID(), capabilities } as unknown as SDKMessage);
const replay = (uuid: string, content: string): SDKMessage => ({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid, session_id: 'native', isReplay: true } as unknown as SDKMessage);
function result(isError = false): SDKMessage {
  return { type: 'result', subtype: 'success', session_id: 'native', uuid: randomUUID(), stop_reason: 'end_turn', result: isError ? '' : 'DONE', is_error: isError,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, permission_denials: [], duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0 } as unknown as SDKMessage;
}
const userRows = (rows: ConversationRow[]) => rows.filter(row => row.kind === 'userInput');

it('回合中途投递的插话写入当前轮的 guided 行，回显后才结算为已投递', async () => {
  const data = fixture(); await data.start();
  let settled: unknown;
  const steering = data.session.steer('改成只跑第一条').then(value => { settled = value; return value; });
  const pushed = await data.nextInput();
  expect(pushed).toMatchObject({ type: 'user', priority: 'next', message: { content: '改成只跑第一条' } });
  await Promise.resolve();
  expect(settled).toBeUndefined();
  data.stream.push(replay(pushed.uuid!, '改成只跑第一条'));
  await expect(steering).resolves.toEqual({ delivered: true });
  const [first, guided] = userRows(data.rows());
  expect(guided).toMatchObject({ text: '改成只跑第一条', guided: true, turnId: first!.turnId, sourceCommandId: pushed.uuid });
  data.stream.push(result());
  await vi.waitFor(() => expect(data.states.at(-1)?.state).toBe('idle'));
});

it('回合先于插话结束时保持运行，CLI 用插话开启的新一轮作为普通回合显示', async () => {
  const data = fixture(); await data.start();
  const steering = data.session.steer('结尾加上总结');
  const pushed = await data.nextInput();
  data.stream.push(result());
  data.stream.push(init([CANCEL_QUEUED]));
  data.stream.push(replay(pushed.uuid!, '结尾加上总结'));
  await expect(steering).resolves.toEqual({ delivered: true });
  // 两轮之间不能出现空闲，否则渲染进程会把队列消息当成可以发送
  expect(data.states.slice(1).some(event => event.state === 'idle')).toBe(false);
  const users = userRows(data.rows());
  expect(users).toHaveLength(2);
  expect(users[1]).toMatchObject({ text: '结尾加上总结' });
  expect(users[1]!.turnId).not.toBe(users[0]!.turnId);
  expect('guided' in users[1]!).toBe(false);
  data.stream.push(result());
  await vi.waitFor(() => expect(data.states.at(-1)?.state).toBe('idle'));
});

it('停止时连同未投递的插话一起撤回，并把内容退回给发起方', async () => {
  const data = fixture(); await data.start();
  const steering = data.session.steer('顺便改一下文案');
  const pushed = await data.nextInput();
  data.stream.interrupt.mockResolvedValueOnce({ cancelled: [pushed.uuid!] });
  await data.session.interrupt();
  expect(data.stream.interrupt).toHaveBeenCalledWith({ cancelQueued: true });
  await expect(steering).resolves.toMatchObject({ delivered: false });
  data.stream.push(result(true));
  await vi.waitFor(() => expect(data.states.at(-1)?.state).not.toBe('running'));
  expect(userRows(data.rows())).toHaveLength(1);
});

it('没有未投递插话时按原方式中断，不撤回 CLI 的其他排队消息', async () => {
  const data = fixture(); await data.start();
  await data.session.interrupt();
  expect(data.stream.interrupt).toHaveBeenCalledWith();
});

it('CLI 不能撤回排队消息或没有进行中的回合时不写入插话，原因随结果退回', async () => {
  const idle = fixture();
  await expect(idle.session.steer('现在就改')).resolves.toMatchObject({ delivered: false, reason: '当前没有进行中的回合' });
  const legacy = fixture(); await legacy.start([]);
  await expect(legacy.session.steer('现在就改')).resolves.toMatchObject({ delivered: false, reason: expect.stringContaining('不支持') });
  legacy.stream.push(result());
  await vi.waitFor(() => expect(legacy.states.at(-1)?.state).toBe('idle'));
  expect(userRows(legacy.rows())).toHaveLength(1);
});

it('进程结束时退回所有未投递的插话', async () => {
  const data = fixture(); await data.start();
  const steering = data.session.steer('再加一个测试');
  await data.nextInput();
  data.stream.close();
  await expect(steering).resolves.toMatchObject({ delivered: false, reason: expect.stringContaining('进程已结束') });
});
