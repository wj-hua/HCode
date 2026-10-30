// 真实 Session、宿主工具分发和文件读取验证评审后的续聊；只替换外部 app-server 传输。
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexSession } from '../codexSession.js';
import type { AppServerClient, ServerRequest } from '../appServerClient.js';
import type { ResearchRuntime } from '../../../sessions/researchRuntime.js';
import type { ChatStateEvent } from '../../../../shared/types.js';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(research = false, resumed = false, holdTurnReply = false, experimentalApi = true) {
  const directory = await mkdtemp(join(tmpdir(), 'hcode-continued-read-'));
  directories.push(directory);
  const root = join(directory, 'project'); await mkdir(root); await writeFile(join(root, 'orientation.txt'), 'portrait; player fullscreen is an exception');
  await writeFile(join(directory, 'outside.txt'), 'outside project');
  const replies: { id: string | number; result: { success: boolean; contentItems: { text: string }[] } }[] = [];
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let turns = 0;
  let releaseTurn: (() => void) | undefined;
  const delegate = vi.fn(async () => ({ deliveryId: 'must-not-dispatch' }));
  const runtime: ResearchRuntime = { root, tools: [{ name: 'delegate_task', description: 'delegate', schema: { taskId: z.string() }, execute: delegate }] };
  const states: ChatStateEvent[] = [];
  const client = {
    running: true, experimentalApi, hostedToolsUnavailableReason: 'CLI 协议缺少 thread/start.dynamicTools', ensureStarted: async () => {},
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === 'config/read') return { config: { developer_instructions: '保留用户既有开发规范' } };
      if (method === 'thread/start') return { thread: { id: 'thread' }, activePermissionProfile: { id: 'hcode_research' } };
      if (method === 'thread/resume') return { model: 'codex' };
      if (method === 'turn/start') { const result = { turn: { id: `turn-${++turns}` } }; if (!holdTurnReply) return result; return new Promise(resolve => { releaseTurn = () => resolve(result); }); }
      if (method === 'thread/unsubscribe') return {};
      if (method === 'thread/inject_items') return {};
      throw new Error(`未配置传输：${method}`);
    },
    respond: (id: string | number, result: typeof replies[number]['result']) => replies.push({ id, result }),
  } as unknown as AppServerClient;
  const session = new CodexSession({ client, emitRows: () => {}, emitState: state => states.push(state), emitPermission: () => {}, emitPermissionResolved: () => {}, onThreadId: () => {}, onTurnCompleted: () => {} }, { key: 'source', projectPath: root, permissionMode: research ? 'read-only' : 'full-access', ...(resumed ? { threadId: 'thread' } : {}), ...(research ? { research: runtime } : {}) });
  const call = async (id: number, tool: string, argumentsValue: unknown, turnId = `turn-${turns}`, threadId = 'thread') => {
    const request: ServerRequest = { id, method: 'item/tool/call', params: { threadId, turnId, callId: `call-${id}`, tool, arguments: argumentsValue } };
    expect(session.handleServerRequest(request), '原生动态工具请求必须获得明确的宿主回应').toBe(true);
    await vi.waitFor(() => expect(replies.some(reply => reply.id === id)).toBe(true));
    return replies.find(reply => reply.id === id)!.result;
  };
  return { session, call, root, directory, replies, requests, states, delegate, releaseTurn: () => releaseTurn?.() };
}
it('评审结束回到普通会话后，原线程的项目读取继续可用，不继承委派闭包或只读权限配置', async () => {
  const f = await fixture(true);
  try {
    await f.session.send('research');
    f.session.handleNotification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await f.session.configureResearch(undefined); await f.session.setPermissionMode('full-access');
    await f.session.send('ordinary follow-up');
    const result = await f.call(1, 'hcode_read_file', { path: 'orientation.txt' });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0]!.text)).toMatchObject({ path: 'orientation.txt', content: 'portrait; player fullscreen is an exception' });
    expect(await f.call(2, 'hcode_delegate_task', { taskId: 'old-task' })).toMatchObject({ success: false });
    expect(f.delegate).not.toHaveBeenCalled();
    expect(f.requests.findLast(request => request.method === 'turn/start')?.params).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    expect(f.requests.findLast(request => request.method === 'turn/start')?.params).not.toHaveProperty('permissions');
  } finally { f.session.close(); }
});
it('应用重启恢复同一原生线程后，读取和目录检索可用，错误包含真实原因', async () => {
  const f = await fixture(false, true);
  try {
    await f.session.send('resumed ordinary follow-up');
    expect(await f.call(1, 'hcode_read_file', { path: 'orientation.txt' })).toMatchObject({ success: true });
    const list = await f.call(2, 'hcode_list_files', { query: 'orientation' });
    expect(list.success).toBe(true); expect(list.contentItems[0]!.text).toContain('orientation.txt');
    const missing = await f.call(3, 'hcode_read_file', { path: 'missing.txt' });
    expect(missing.success).toBe(false); expect(missing.contentItems[0]!.text).toContain('ENOENT');
    expect(missing.contentItems[0]!.text).not.toContain('dynamic tool request failed');
  } finally { f.session.close(); }
});
it('普通续聊仍拒绝项目外读取、跨线程和旧回合调用', async () => {
  const f = await fixture(false, true);
  try {
    await f.session.send('ordinary');
    expect(await f.call(1, 'hcode_read_file', { path: '../outside.txt' })).toMatchObject({ success: false });
    expect(await f.call(2, 'hcode_read_file', { path: 'orientation.txt' }, 'turn-1', 'other-thread')).toMatchObject({ success: false });
    f.session.handleNotification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    expect(await f.call(3, 'hcode_read_file', { path: 'orientation.txt' }, 'turn-1')).toMatchObject({ success: false });
  } finally { f.session.close(); }
});

it('原生 turn/started 早于 turn/start 响应时，读取请求仍得到真实结果', async () => {
  const f = await fixture(false, true, true);
  try {
    const sent = f.session.send('early tool call');
    await vi.waitFor(() => expect(f.requests.some(request => request.method === 'turn/start')).toBe(true));
    f.session.handleNotification('turn/started', { turn: { id: 'turn-1', status: 'inProgress' } });
    expect(await f.call(1, 'hcode_read_file', { path: 'orientation.txt' })).toMatchObject({ success: true });
    f.releaseTurn(); await sent;
    expect(f.replies).toHaveLength(1);
  } finally { f.releaseTurn(); f.session.close(); }
});
it('普通交接保留用户开发者指令和原线程，以正常配置恢复且不污染用户消息', async () => {
  const f = await fixture(false, true);
  try {
    await f.session.configureContinuation('旧评审限制仅属于历史回合，按最新请求继续');
    await f.session.send('用户原话');
    expect(f.requests.find(request => request.method === 'thread/resume')?.params).toMatchObject({ threadId: 'thread', sandbox: 'danger-full-access', config: {}, developerInstructions: '保留用户既有开发规范' });
    expect(f.requests.find(request => request.method === 'turn/start')?.params).toMatchObject({ input: [{ type: 'text', text: '用户原话', text_elements: [] }], outputSchema: null });
    expect(f.requests.find(request => request.method === 'thread/inject_items')?.params).toMatchObject({ threadId: 'thread', items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '旧评审限制仅属于历史回合，按最新请求继续' }] }] });
    expect(f.requests.find(request => request.method === 'turn/start')?.params).not.toHaveProperty('permissions');
  } finally { f.session.close(); }
});
it('普通新线程注册 call_agent 并返回原生工具结果，后续回合只使用新的执行闭包', async () => {
  const f = await fixture();
  const first = vi.fn(async () => ({ status: 'succeeded', output: '子 AI 的实际报告' }));
  const runtime = { root: f.root, instructions: '使用 call_agent 再继续下一步', tools: [{ name: 'call_agent', description: '调用另一个 AI', schema: { prompt: z.string() }, execute: first }] };
  try {
    await f.session.configureHosted(runtime);
    await f.session.send('后面都直接展示了 效果不行 你让codex调整吧');
    expect(f.requests.find(request => request.method === 'thread/start')?.params.dynamicTools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'hcode_call_agent' })]));
    expect(f.requests.find(request => request.method === 'turn/start')?.params).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
    expect(await f.call(1, 'hcode_call_agent', { prompt: '当前 AI 生成的任务' })).toMatchObject({ success: true, contentItems: [{ type: 'inputText', text: expect.stringContaining('子 AI 的实际报告') }] });
    expect(first).toHaveBeenCalledWith({ prompt: '当前 AI 生成的任务' });
    f.session.handleNotification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    const next = vi.fn(async () => ({ status: 'succeeded', output: '下一步实际报告' }));
    await f.session.configureHosted({ ...runtime, tools: [{ ...runtime.tools[0]!, execute: next }] });
    await f.session.send('下一轮继续');
    expect(await f.call(2, 'hcode_call_agent', { prompt: '后续任务' })).toMatchObject({ success: true });
    expect(next).toHaveBeenCalledWith({ prompt: '后续任务' });
    expect(first).toHaveBeenCalledTimes(1);
  } finally { f.session.close(); }
});
it('普通旧线程没有 call_agent 时仍可聊天，明确说明限制并拒绝未注册的执行调用', async () => {
  const f = await fixture();
  const invoke = vi.fn(async () => ({ status: 'succeeded' }));
  try {
    await f.session.send('之前的普通回合');
    f.session.handleNotification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await f.session.configureHosted({ root: f.root, tools: [{ name: 'call_agent', description: 'call', schema: { prompt: z.string() }, execute: invoke }] });
    await f.session.send('继续当前原生会话');
    expect(f.requests.find(request => request.method === 'thread/inject_items')?.params).toMatchObject({ threadId: 'thread', items: [expect.objectContaining({ role: 'developer', content: [expect.objectContaining({ text: expect.stringContaining('未注册') })] })] });
    expect(JSON.stringify(f.requests.find(request => request.method === 'thread/inject_items')?.params)).toContain('不得通过终端');
    expect(await f.call(1, 'hcode_call_agent', { prompt: '不应执行' })).toMatchObject({ success: false });
    expect(invoke).not.toHaveBeenCalled();
    expect(f.requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
  } finally { f.session.close(); }
});

it('启用委派但 CLI 缺少协议能力时明确失败，不创建无工具线程或发送模型回合', async () => {
  const f = await fixture(false, false, false, false);
  try {
    await f.session.configureHosted({ root: f.root, tools: [{ name: 'call_agent', description: 'call', schema: {}, execute: async () => ({}) }] });
    await f.session.send('让 Claude 审核');
    expect(f.states).toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.stringContaining('CLI 协议缺少 thread/start.dynamicTools') })]));
    expect(f.requests.some(request => request.method === 'thread/start' || request.method === 'turn/start')).toBe(false);
  } finally { f.session.close(); }
});

it('未启用宿主工具时，不支持实验协议的 CLI 仍可普通聊天', async () => {
  const f = await fixture(false, false, false, false);
  try {
    await f.session.send('普通聊天');
    expect(f.requests.find(request => request.method === 'thread/start')?.params).not.toHaveProperty('dynamicTools');
    expect(f.requests.some(request => request.method === 'turn/start')).toBe(true);
  } finally { f.session.close(); }
});

it('新增并行工具不关闭旧 Codex 线程已有的单项委派，未注册批量工具明确拒绝', async () => {
  const f = await fixture();
  const execute = vi.fn(async () => ({ status: 'succeeded' }));
  const single = { name: 'call_agent', description: 'call', schema: { prompt: z.string() }, execute };
  const parallel = { name: 'call_agents', description: 'parallel', schema: {}, execute };
  try {
    await f.session.configureHosted({ root: f.root, tools: [single] });
    await f.session.send('旧版单项委派');
    f.session.handleNotification('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await f.session.configureHosted({ root: f.root, instructions: '支持 call_agent 和 call_agents', tools: [single, parallel] });
    await f.session.send('升级后继续');
    expect(await f.call(1, 'hcode_call_agent', { prompt: '仍可调用' })).toMatchObject({ success: true });
    expect(await f.call(2, 'hcode_call_agents', {})).toMatchObject({ success: false });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.requests.findLast(request => request.method === 'thread/inject_items')!.params).toMatchObject({ items: [expect.objectContaining({ content: [expect.objectContaining({ text: expect.stringContaining('call_agents') })] })] });
    expect(f.requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
  } finally { f.session.close(); }
});
