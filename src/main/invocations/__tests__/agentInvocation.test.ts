// 工具公开行为验证：真实执行服务和持久化，只有原生 Provider 传输被替换。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatSendParams } from '../../../shared/types.js';
import type { AgentSendParams } from '../../agents/types.js';
import type { AgentInvocation } from '../../../shared/agentInvocation.js';
import { SessionExecutionService } from '../../sessions/sessionExecutionService.js';
import { InvocationRepository } from '../invocationRepository.js';
import { AgentInvocationService } from '../agentInvocationService.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const source: ChatSendParams = { agent: 'claude', sessionKey: 'source', resumeSessionId: 'native-source', projectPath: '/project', permissionMode: 'bypassPermissions', text: '后面都直接展示了 效果不行 你让codex调整吧' };
async function fixture(outcome: 'succeeded' | 'failed' = 'succeeded', hold = false, acknowledgeStop = true, sendError?: Error) {
  const root = await mkdtemp(join(tmpdir(), 'hcode-invoke-')); roots.push(root);
  const sent: AgentSendParams[] = [], updates: AgentInvocation[] = [];
  let execution: SessionExecutionService;
  let finish!: () => void;
  execution = new SessionExecutionService({ prepare: async params => params, failedToSend: () => {}, finishedSending: () => {}, interrupt: async key => {
    if (!acknowledgeStop) return;
    const params = sent.find(entry => entry.sessionKey === key)!;
    execution.acceptOutcome({ sessionKey: key, agent: params.agent, executionTurnId: params.executionTurnId!, outcome: 'cancelled', text: '' });
  }, send: async params => {
    sent.push(params);
    if (sendError) throw sendError;
    finish = () => execution.acceptOutcome({ sessionKey: params.sessionKey, agent: params.agent, executionTurnId: params.executionTurnId!, nativeSessionId: 'native-worker', outcome, text: 'CODEX_ACTUAL_RESULT', ...(outcome === 'failed' ? { error: 'quota exhausted' } : {}) });
    if (!hold) finish();
    return { sessionKey: params.sessionKey };
  } });
  const repository = new InvocationRepository(root);
  const service = new AgentInvocationService(repository, execution, call => updates.push(call), () => 'selected-model');
  const abort = new AbortController();
  const runtime = service.tools(source, 'source-turn', abort.signal);
  return { service, execution, sent, updates, repository, abort, call: (input: Record<string, unknown>) => runtime.tools![0]!.execute(input), finish: () => finish() };
}
it('主 AI 的提示词原样执行，当前项目和权限继承；真实结果回到同一次工具调用', async () => {
  const f = await fixture();
  const prompt = '读取补丁并修复双重旋转，保留旧限制。';
  const result = await f.call({ agent: 'codex', mode: 'execute', prompt });
  expect(f.sent[0]).toMatchObject({ agent: 'codex', text: prompt, projectPath: '/project', permissionMode: 'full-access', model: 'selected-model' });
  expect(f.sent[0]?.hosted).toBeUndefined();
  expect(result).toMatchObject({ status: 'succeeded', output: 'CODEX_ACTUAL_RESULT', nativeSessionId: 'native-worker' });
  expect(f.updates.map(call => call.status)).toEqual(['running', 'succeeded']);
  expect(await f.service.list('source')).toHaveLength(1);
});
it('只读审核设置真正受限运行时，源会话不能借工具突破计划模式', async () => {
  const f = await fixture();
  await f.call({ agent: 'codex', mode: 'read-only', prompt: '只审核' });
  expect(f.sent[0]?.research).toMatchObject({ root: '/project' });
  expect(f.sent[0]?.permissionMode).toBe('read-only');
  const tools = f.service.tools({ ...source, permissionMode: 'plan' }, 'plan-turn', new AbortController().signal);
  await expect(tools.tools![0]!.execute({ agent: 'codex', mode: 'execute', prompt: '写入' })).rejects.toThrow('计划模式');
});
it('失败回传明确状态和原生错误，不做自动互审或假成功', async () => {
  const f = await fixture('failed');
  expect(await f.call({ agent: 'codex', mode: 'execute', prompt: '修复' })).toMatchObject({ status: 'failed', error: 'quota exhausted' });
  expect(f.sent).toHaveLength(1);
});
it('CLI 启动失败返回 failed 和具体原因，不伪装成已启动或已完成', async () => {
  const f = await fixture('succeeded', false, true, new Error('CLI unavailable'));
  expect(await f.call({ agent: 'codex', mode: 'execute', prompt: '任务' })).toMatchObject({ status: 'failed', error: 'CLI unavailable' });
});
it('完成后可以续接同一个子会话，不能接管其他源会话的记录', async () => {
  const f = await fixture();
  const result = await f.call({ agent: 'codex', mode: 'execute', prompt: '第一步' }) as { invocationId: string };
  await f.call({ agent: 'codex', mode: 'execute', prompt: '下一步', continueInvocationId: result.invocationId });
  expect(f.sent[1]?.resumeSessionId).toBe('native-worker');
  const other = f.service.tools({ ...source, sessionKey: 'other', resumeSessionId: 'other-native' }, 'other-turn', new AbortController().signal);
  await expect(other.tools![0]!.execute({ agent: 'codex', mode: 'execute', prompt: '跨会话', continueInvocationId: result.invocationId })).rejects.toThrow('当前源会话');
});
it('并行写入被拒绝；源回合取消会传播到子会话', async () => {
  const f = await fixture('succeeded', true);
  const pending = f.call({ agent: 'codex', mode: 'execute', prompt: '执行' });
  while (!f.sent.length) await new Promise(resolve => setTimeout(resolve, 1));
  await expect(f.call({ agent: 'codex', mode: 'execute', prompt: '同项目另一写入' })).rejects.toThrow('已有 AI');
  f.abort.abort();
  expect(await pending).toMatchObject({ status: 'cancelled' });
  await expect(f.call({ agent: 'codex', mode: 'read-only', prompt: '迟到请求' })).rejects.toThrow('取消');
});
it('重启不会把磁盘上的 running 当成继续执行或已成功', async () => {
  const f = await fixture();
  const call: AgentInvocation = { id: randomUUID(), seq: 1, createdAt: 1, source, sourceTurnId: 'old-turn', input: { agent: 'codex', mode: 'execute', prompt: '旧任务' }, sessionKey: randomUUID(), status: 'running' };
  await f.repository.save(call);
  expect((await f.service.list('source'))[0]).toMatchObject({ status: 'interrupted', error: expect.stringContaining('未自动续跑') });
  expect(f.sent).toHaveLength(0);
});
it('停止未获确认时仍保留项目写入锁，迟到原生终态之后才允许新调用', async () => {
  const f = await fixture('succeeded', true, false);
  const pending = f.call({ agent: 'codex', mode: 'execute', prompt: '执行' });
  while (!f.sent.length) await new Promise(resolve => setTimeout(resolve, 1));
  vi.useFakeTimers();
  try {
    f.abort.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ status: 'interrupted', error: expect.stringContaining('未收到原生中断确认') });
    const runtime = f.service.tools(source, 'next-turn', new AbortController().signal);
    await expect(runtime.tools![0]!.execute({ agent: 'codex', mode: 'execute', prompt: '新写入' })).rejects.toThrow('停止未确认');
    f.finish();
    const next = runtime.tools![0]!.execute({ agent: 'codex', mode: 'execute', prompt: '已确认后的写入' });
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    f.finish();
    expect(await next).toMatchObject({ status: 'succeeded' });
  } finally { vi.useRealTimers(); }
});
