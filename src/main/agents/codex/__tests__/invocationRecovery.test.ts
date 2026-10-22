// 原生传输边界验证：恢复必须沿用同一线程，且持久化成功后才允许 turn/start。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { TurnOutcome } from '../../../../shared/collaboration.js';
import type { AppServerClient } from '../appServerClient.js';
import { CodexSession } from '../codexSession.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(resume = false, nativeStatus = 'idle') {
  const root = await mkdtemp(join(tmpdir(), 'hcode-codex-recovery-')); roots.push(root);
  const requests: { method: string; params: Record<string, unknown> }[] = [], outcomes: TurnOutcome[] = [];
  const thread = { id: 'original-thread', cwd: root, status: { type: nativeStatus } };
  const client = { running: true, ensureStarted: async () => {}, request: async (method: string, params: Record<string, unknown>) => {
    requests.push({ method, params });
    if (method === 'thread/read') return { thread };
    if (method === 'thread/start' || method === 'thread/resume') { thread.status.type = 'idle'; return { thread: { id: 'original-thread' } }; }
    if (method === 'turn/start') return { turn: { id: 'new-turn' } };
    if (method === 'thread/unsubscribe') return {};
    throw new Error(`未配置传输：${method}`);
  } } as unknown as AppServerClient;
  const session = new CodexSession({ client, emitRows: () => {}, emitState: () => {}, emitPermission: () => {}, emitPermissionResolved: () => {}, onThreadId: () => {}, onTurnCompleted: () => {}, emitTurnOutcome: result => outcomes.push(result) }, { key: 'restored-key', projectPath: root, permissionMode: 'full-access', ...(resume ? { threadId: 'original-thread' } : {}) });
  return { session, requests, outcomes, thread };
}
it('新建 Codex 委派在原生身份保存前不执行任何任务', async () => {
  const data = await fixture();
  let persist!: () => void;
  const saved = new Promise<void>(resolve => { persist = resolve; });
  const checkpoint = vi.fn(async () => saved);
  const pending = data.session.send('原任务', [], [], undefined, 'execution', checkpoint);
  try {
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledWith('original-thread'));
    expect(data.requests.some(request => request.method === 'turn/start')).toBe(false);
    persist(); await pending;
    expect(data.requests.find(request => request.method === 'turn/start')?.params.threadId).toBe('original-thread');
  } finally { persist(); await pending; data.session.close(); }
});
it('恢复时核验原生状态，发送给原线程且不调用 thread/start', async () => {
  const data = await fixture(true);
  try {
    await data.session.send('继续原任务', [], [], undefined, 'execution', async () => {});
    expect(data.requests.some(request => request.method === 'thread/read')).toBe(true);
    expect(data.requests.some(request => request.method === 'thread/start')).toBe(false);
    expect(data.requests.find(request => request.method === 'thread/resume')?.params.threadId).toBe('original-thread');
    expect(data.requests.find(request => request.method === 'turn/start')?.params.threadId).toBe('original-thread');
  } finally { data.session.close(); }
});
it('未加载的旧线程必须经原生恢复确认空闲后再发送', async () => {
  const data = await fixture(true, 'notLoaded');
  try {
    await data.session.send('继续', [], [], undefined, 'execution', async () => {});
    expect(data.requests.find(request => request.method === 'turn/start')?.params.threadId).toBe('original-thread');
    expect(data.requests.some(request => request.method === 'thread/start')).toBe(false);
  } finally { data.session.close(); }
});
it.each(['identity', 'project'] as const)('原生线程的 %s 不匹配时不发送任务', async mismatch => {
  const data = await fixture(true);
  if (mismatch === 'identity') data.thread.id = 'another-thread';
  else data.thread.cwd = tmpdir();
  try {
    await data.session.send('继续', [], [], undefined, 'execution', async () => {});
    expect(data.outcomes.at(-1)).toMatchObject({ outcome: 'failed', error: expect.stringContaining('不匹配') });
    expect(data.requests.some(request => request.method === 'thread/start' || request.method === 'turn/start')).toBe(false);
  } finally { data.session.close(); }
});
it.each(['active', 'systemError', 'unknown'])('原生状态 %s 时拒绝续跑，不开替代线程', async status => {
  const data = await fixture(true, status);
  try {
    await data.session.send('继续', [], [], undefined, 'execution', async () => {});
    expect(data.outcomes.at(-1)).toMatchObject({ outcome: 'failed', nativeSessionId: 'original-thread' });
    expect(data.requests.some(request => request.method === 'thread/start' || request.method === 'turn/start')).toBe(false);
  } finally { data.session.close(); }
});
it('持久化失败报告错误，不执行任务', async () => {
  const data = await fixture();
  try {
    await data.session.send('任务', [], [], undefined, 'execution', async () => { throw new Error('磁盘不可写'); });
    expect(data.outcomes.at(-1)).toMatchObject({ outcome: 'failed', error: '磁盘不可写' });
    expect(data.requests.some(request => request.method === 'turn/start')).toBe(false);
  } finally { data.session.close(); }
});
