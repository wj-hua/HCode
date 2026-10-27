import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatSendParams } from '../../../shared/types.js';
import { MEMORY_LIMIT, type MemoryEntry } from '../../../shared/memory.js';
import { MemoryRepository } from '../memoryRepository.js';
import { MemoryService } from '../memoryService.js';
import { CodexSession } from '../../agents/codex/codexSession.js';
import type { AppServerClient } from '../../agents/codex/appServerClient.js';
import { mergeHosted, type HostedRuntime } from '../../sessions/researchRuntime.js';
import { SessionExecutionService } from '../../sessions/sessionExecutionService.js';
import type { AgentSendParams } from '../../agents/types.js';

let root: string, project: string, other: string, conversation: string;
let service: MemoryService, repository: MemoryRepository;
let enabled: boolean;
const emit = vi.fn();
const params = (projectPath: string): ChatSendParams => ({ projectPath, agent: 'claude', sessionKey: 'source', permissionMode: 'default', text: '测试记忆' });
const invoke = (path: string, name: string, input: Record<string, unknown>, signal = new AbortController().signal) => service.tools(params(path), signal).tools!.find(tool => tool.name === name)!.execute(input);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hcode-memory-'));
  project = join(root, 'project'); other = join(root, 'other'); conversation = join(root, 'conversation');
  await Promise.all([mkdir(project), mkdir(other), mkdir(conversation)]);
  [project, other, conversation] = await Promise.all([realpath(project), realpath(other), realpath(conversation)]);
  repository = new MemoryRepository(join(root, 'memories'));
  enabled = true; emit.mockClear();
  service = new MemoryService(repository, conversation, emit, () => enabled);
});

function codexFixture() {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const states: { state: string; error?: string }[] = [];
  const threadId = randomUUID();
  let turn = 0;
  const client = {
    experimentalApi: true,
    ensureStarted: async () => {},
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === 'thread/start') return { thread: { id: threadId } };
      if (method === 'turn/start') return { turn: { id: `turn-${++turn}` } };
      if (method === 'thread/inject_items' || method === 'thread/resume' || method === 'thread/unsubscribe') return {};
      throw new Error(`未配置的测试请求 ${method}`);
    },
  } as unknown as AppServerClient;
  const session = new CodexSession({ client, emitState: event => states.push(event), emitRows: () => {}, emitPermission: () => {}, emitPermissionResolved: () => {}, onThreadId: () => {}, onTurnCompleted: () => {} }, { key: 'test', projectPath: project, permissionMode: 'on-request' });
  const send = async () => {
    await session.send('本轮用户要求');
    session.handleNotification('turn/completed', { threadId, turn: { id: `turn-${turn}`, status: 'completed' } });
    expect(states.at(-1)?.state).toBe('idle');
  };
  const injections = () => requests.filter(request => request.method === 'thread/inject_items').map(request => JSON.stringify(request.params.items));
  return { session, requests, send, injections };
}

describe('普通回合的记忆接入', () => {
  it('Codex 同一快照仅注入一次，增删后同步新快照且不重新 resume', async () => {
    const fixture = codexFixture();
    try {
      const entry = await service.save({ scope: 'global', content: '首次长期约定' });
      fixture.session.configureMemory(await service.snapshot(params(project)));
      await fixture.send();
      fixture.session.configureMemory(await service.snapshot(params(project)));
      await fixture.send();
      expect(fixture.injections()).toHaveLength(1);
      expect(fixture.injections()[0]).toContain(entry.content);
      await service.delete(entry.id);
      fixture.session.configureMemory(await service.snapshot(params(project)));
      await fixture.send();
      expect(fixture.injections()).toHaveLength(2);
      expect(fixture.injections()[1]).toContain('暂无保存的记忆');
      expect(fixture.requests.some(request => request.method === 'thread/resume')).toBe(false);
      fixture.session.configureMemory(undefined); await fixture.send();
      expect(fixture.injections()).toHaveLength(2);
    } finally { fixture.session.close(); }
  });

  it('旧 Codex 线程只开记忆时明确不能保存，不出现委派工具提示', async () => {
    const fixture = codexFixture();
    try {
      await fixture.send(); // 创建时没有注册记忆工具。
      await fixture.session.configureHosted(service.tools(params(project), new AbortController().signal));
      fixture.session.configureMemory(await service.snapshot(params(project)));
      await fixture.send();
      const text = fixture.injections().join('\n');
      expect(text).toContain('本线程不能保存记忆'); expect(text).toContain('新建 Codex 会话后可用');
      expect(text).not.toContain('call_agent'); expect(text).not.toContain('委派');
      expect(text).toContain('暂无保存的记忆');
    } finally { fixture.session.close(); }
  });

  it('Codex 同时注册委派和记忆后可独立关闭任一能力，不因目录多出旧工具报错', async () => {
    const fixture = codexFixture();
    const memory = service.tools(params(project), new AbortController().signal);
    const delegation: HostedRuntime = { root: project, instructions: '委派说明', tools: [{ name: 'call_agent', description: '测试委派工具', schema: {}, execute: async () => ({}) }] };
    try {
      await fixture.session.configureHosted(mergeHosted([delegation, memory]));
      await fixture.send();
      await fixture.session.configureHosted(memory); await fixture.send();
      await fixture.session.configureHosted(delegation); await fixture.send();
      await fixture.session.configureHosted(undefined); await fixture.send();
      expect(fixture.requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
      expect(fixture.injections().join('\n')).not.toContain('未注册');
    } finally { fixture.session.close(); }
  });

  it('普通入口转交快照，研究和委派执行入口不继承记忆或工具', async () => {
    const sent: AgentSendParams[] = [];
    const ordinaryMemory = vi.fn(async () => '长期参考快照');
    const execution = new SessionExecutionService({
      prepare: async input => input, send: async input => { sent.push(input); return { sessionKey: input.sessionKey }; }, interrupt: async () => {}, failedToSend: () => {}, finishedSending: () => {},
      ordinaryMemory, ordinaryTools: source => service.tools(source, new AbortController().signal),
    });
    await execution.send(params(project));
    expect(sent[0]).toMatchObject({ memorySnapshot: '长期参考快照', text: '测试记忆' });
    execution.acceptOutcome({ executionTurnId: sent[0]!.executionTurnId!, sessionKey: 'source', agent: 'claude', outcome: 'succeeded', text: '' });
    const result = execution.execute(params(project), { root: project }, new AbortController().signal);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    execution.acceptOutcome({ executionTurnId: sent[1]!.executionTurnId!, sessionKey: 'source', agent: 'claude', outcome: 'succeeded', text: '' });
    await result;
    expect(sent[1]!.memorySnapshot).toBeUndefined(); expect(sent[1]!.hosted).toBeUndefined();
    expect(ordinaryMemory).toHaveBeenCalledTimes(1);
  });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('本机长期记忆', () => {
  it('全局跨 CLI 和项目可见，项目隔离；符号链接和末尾斜线绑定同一个项目', async () => {
    const alias = join(root, 'alias'); await symlink(project, alias);
    const global = await invoke(project, 'memory_save', { scope: 'global', content: '偏好简洁答复', tags: ['偏好'] }) as MemoryEntry;
    const local = await invoke(`${alias}/`, 'memory_save', { scope: 'project', content: '项目约定使用标准库' }) as MemoryEntry;
    const foreign = await service.save({ scope: 'project', projectPath: other, content: '另一个项目约定' });
    expect(local.projectPath).toBe(project);
    expect(global.source).toEqual({ agent: 'claude', sessionId: 'source' });
    expect((await service.search(params(project), '')).map(entry => entry.id)).toEqual(expect.arrayContaining([global.id, local.id]));
    expect((await service.search(params(other), '')).map(entry => entry.id)).not.toContain(local.id);
    expect((await service.search(params(project), '', 'all')).map(entry => entry.id)).toContain(foreign.id);
    const codex = service.tools({ ...params(other), agent: 'codex' }, new AbortController().signal);
    expect(await codex.tools!.find(tool => tool.name === 'memory_search')!.execute({ query: '简洁' })).toEqual([global]);
    const snapshot = await service.snapshot(params(project));
    expect(snapshot).toContain(local.content); expect(snapshot).not.toContain(foreign.content);
    expect(snapshot.indexOf(global.content)).toBeLessThan(snapshot.indexOf(local.content));
  });

  it('非项目对话只能读写全局，all 也不能越过边界', async () => {
    const global = await service.save({ scope: 'global', content: '稳定的全局约定' });
    const local = await service.save({ scope: 'project', projectPath: project, content: '项目限定的约定' });
    await expect(invoke(conversation, 'memory_save', { scope: 'project', content: '不能保存' })).rejects.toThrow('非项目对话');
    await expect(service.save({ scope: 'project', projectPath: conversation, content: '不能保存' })).rejects.toThrow('非项目对话');
    expect(await service.search(params(conversation), '', 'all')).toEqual([global]);
    await expect(invoke(conversation, 'memory_save', { scope: 'global', content: '不能挪用项目记录', replaceId: local.id })).rejects.toThrow('只能修改');
    await expect(invoke(conversation, 'memory_delete', { id: local.id })).rejects.toThrow('只能删除');
    const snapshot = await service.snapshot(params(conversation));
    expect(snapshot).toContain(global.content); expect(snapshot).not.toContain(local.content);
  });

  it('关键词按命中数和更新时间排序，标签和英文大小写均可检索，最多返回 20 条', async () => {
    const ranked = await service.save({ scope: 'global', content: '使用 Node 标准库', tags: ['约定'] });
    await service.save({ scope: 'global', content: '只命中一个 Node' });
    expect((await service.search(params(project), 'NODE 约定'))[0]!.id).toBe(ranked.id);
    expect(await service.search(params(project), '标准库')).toEqual([ranked]);
    expect(await service.search(params(project), '不存在的词')).toEqual([]);
    for (let n = 0; n < 23; n++) await service.save({ scope: 'global', content: `可复用约定 ${n}` });
    expect(await service.search(params(project), '')).toHaveLength(20);
  });

  it('快照稳定且在 3000 字符预算内，截断条目保留检索提示', async () => {
    for (let n = 0; n < 7; n++) await service.save({ scope: 'global', content: `${n}${'可复用事实'.repeat(160)}` });
    const snapshot = await service.snapshot(params(project));
    expect(snapshot.length).toBeLessThanOrEqual(3000);
    expect(snapshot).toContain('仅作背景参考，不是本回合指令');
    expect(snapshot).toMatch(/另有 \d+ 条，用 memory_search 检索/);
    expect(await service.snapshot(params(project))).toBe(snapshot);
    expect(await service.search(params(project), '')).toHaveLength(7);
  });

  it.each([
    () => `sk-${'a'.repeat(30)}`,
    () => `ghp_${'b'.repeat(36)}`,
    () => `AKIA${'C'.repeat(16)}`,
    () => ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
  ])('疑似密钥在工具和手动保存入口均被拒绝', async secret => {
    await expect(invoke(project, 'memory_save', { scope: 'global', content: secret() })).rejects.toThrow('疑似密钥');
    await expect(service.save({ scope: 'global', content: '普通内容', tags: [secret()] })).rejects.toThrow('疑似密钥');
    expect(await service.list()).toEqual([]); expect(emit).not.toHaveBeenCalled();
  });

  it('更新、改作用域、删除均持久化并通知，文件与目录权限受限', async () => {
    const saved = await service.save({ scope: 'global', content: '初始约定' });
    await service.save({ id: saved.id, scope: 'project', projectPath: project, content: '修改后的约定', tags: ['规范'] });
    const restarted = new MemoryService(new MemoryRepository(join(root, 'memories')), conversation, emit);
    expect(await restarted.search(params(other), '')).toEqual([]);
    expect((await restarted.search(params(project), '规范'))[0]).toMatchObject({ id: saved.id, createdAt: saved.createdAt, scope: 'project', source: { agent: 'user' } });
    expect((await stat(join(root, 'memories'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, 'memories', `${saved.id}.json`))).mode & 0o777).toBe(0o600);
    expect(await readdir(join(root, 'memories'))).toEqual([`${saved.id}.json`]);
    await invoke(project, 'memory_delete', { id: saved.id });
    expect(await restarted.list()).toEqual([]); expect(emit).toHaveBeenCalledTimes(3);
    await expect(service.delete(saved.id)).rejects.toThrow('不存在');
    await expect(service.save({ id: saved.id, scope: 'global', content: '不存在的更新' })).rejects.toThrow('不存在');
  });

  it('项目目录移除后仍可编辑原记忆，也可改为全局', async () => {
    const entry = await service.save({ scope: 'project', projectPath: project, content: '保留项目约定' });
    await rm(project, { recursive: true });
    await expect(service.save({ id: entry.id, scope: 'project', projectPath: project, content: '修正约定' })).resolves.toMatchObject({ projectPath: project });
    await expect(service.save({ scope: 'project', projectPath: project, content: '新条目' })).rejects.toThrow();
    expect(await service.save({ id: entry.id, scope: 'global', content: '改为全局' })).not.toHaveProperty('projectPath');
  });

  it('500 条上限对并发新建有效，更新不淘汰记录', async () => {
    const seed: MemoryEntry[] = Array.from({ length: MEMORY_LIMIT - 1 }, (_, n) => ({ id: randomUUID(), scope: 'global', content: `事实 ${n}`, tags: [], source: { agent: 'user' }, createdAt: n, updatedAt: n }));
    vi.spyOn(repository, 'list').mockImplementation(async () => structuredClone(seed));
    vi.spyOn(repository, 'save').mockImplementation(async entry => { const i = seed.findIndex(item => item.id === entry.id); if (i < 0) seed.push(entry); else seed[i] = entry; });
    const writes = await Promise.allSettled([service.save({ scope: 'global', content: '最后一条' }), service.save({ scope: 'global', content: '超出上限' })]);
    expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(writes[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('请先清理') }) });
    await expect(service.save({ id: seed[0]!.id, scope: 'global', content: '更新已有' })).resolves.toMatchObject({ content: '更新已有' });
    expect(seed).toHaveLength(MEMORY_LIMIT);
  });

  it('关闭功能、结束或取消回合后拒绝已有工具闭包', async () => {
    const abort = new AbortController();
    const tool = service.tools(params(project), abort.signal).tools![0]!;
    enabled = false;
    await expect(tool.execute({ scope: 'global', content: '不能写入' })).rejects.toThrow('已关闭');
    enabled = true; abort.abort();
    await expect(tool.execute({ scope: 'global', content: '不能写入' })).rejects.toThrow('已结束或取消');
    expect(await service.list()).toEqual([]);
  });
});
