// 从主 AI 工具入口验证并行、冲突反馈和真实文件结果，不替换写入策略或任务编排。
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { callResearchTool } from '../../agents/codex/researchTools.js';
import { readResearchFile } from '../../sessions/researchRuntime.js';
import type { AgentSendParams } from '../../agents/types.js';
import { parallelInvocationFixture } from './parallelInvocationFixture.js';

const fixtures: Awaited<ReturnType<typeof parallelInvocationFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
async function fixture() { const data = await parallelInvocationFixture(); fixtures.push(data); return data; }
const writer = (input: AgentSendParams) => input.research!.tools!.find(tool => tool.name === 'write_file')!;

it('Gemini 与 Codex 同时进入受限执行，各自写入真实文件，批量结果等待两项终态', async () => {
  const data = await fixture();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  data.handle(async input => {
    await barrier;
    const path = input.agent === 'agy' ? 'ui.txt' : 'business.txt';
    const file = await readResearchFile(input.projectPath, path);
    await writer(input).execute({ path, expectedHash: file.hash, content: `new-${path}` });
    return `FINISHED_${input.agent}`;
  });
  const pending = data.batch();
  try {
    await vi.waitFor(() => expect(data.sent).toHaveLength(2));
    const running = await data.service.list(data.source.sessionKey);
    expect(running.map(call => call.status)).toEqual(['running', 'running']);
    expect(new Set(running.map(call => call.writeScope!.batchId)).size).toBe(1);
    expect(data.sent.find(input => input.agent === 'agy')!.permissionMode).toBe('default');
    expect(data.sent.find(input => input.agent === 'codex')!.permissionMode).toBe('read-only');
    expect(data.sent.every(input => input.research && !input.hosted && input.text.includes('不能运行构建或测试'))).toBe(true);
  } finally { release(); }
  expect(await pending).toMatchObject({ status: 'succeeded', results: expect.arrayContaining([expect.objectContaining({ agent: 'agy', status: 'succeeded', output: 'FINISHED_agy', writeScope: { batchId: expect.any(String), taskKey: 'ui', allowedPaths: ['ui.txt'] } })]) });
  expect(await readFile(join(data.project, 'ui.txt'), 'utf8')).toBe('new-ui.txt');
  expect(await readFile(join(data.project, 'business.txt'), 'utf8')).toBe('new-business.txt');
  const saved = await data.service.list(data.source.sessionKey);
  expect(saved.every(call => call.status === 'succeeded')).toBe(true);
  await expect(data.runtime.tools![0]!.execute({ agent: saved[0]!.input.agent, mode: 'execute', continueInvocationId: saved[0]!.id, prompt: '去掉文件范围限制' })).rejects.toThrow('不能通过普通');
});

it.each([['ui.txt', 'ui.txt'], ['ui.txt', 'UI.txt'], ['new', 'new/child.txt'], ['café.txt', 'cafe\u0301.txt']])('重叠范围 %s / %s 整批拒绝，向主 AI 返回路径和调整建议，修正后可重新派发', async (first, second) => {
  const data = await fixture();
  const tasks = data.tasks.map((task, index) => ({ ...task, allowedPaths: [index ? second : first] }));
  const response = await callResearchTool(data.runtime, { tool: 'hcode_call_agents', arguments: { tasks } });
  expect(response.success).toBe(false);
  expect(JSON.parse(response.contentItems[0]!.text)).toMatchObject({ code: 'write_scope_conflict', status: 'blocked', dispatched: false, conflicts: [{ path: second, otherPath: first, taskKeys: ['ui', 'business'] }], guidance: expect.arrayContaining([expect.stringContaining('调整提示词')]) });
  expect(data.sent).toHaveLength(0);
  expect(await data.service.list(data.source.sessionKey)).toEqual([]);
  expect(await data.batch()).toMatchObject({ status: 'succeeded' });
  expect(data.sent).toHaveLength(2);
});

it('越界与过期 hash 被实际阻止，反馈不依赖子 AI 转述并返回主 AI 和持久化记录', async () => {
  const data = await fixture();
  data.handle(async input => {
    if (input.agent !== 'agy') return 'BUSINESS_DONE';
    await expect(writer(input).execute({ path: 'business.txt', expectedHash: null, content: 'overwrite-business' })).rejects.toThrow('write_scope_violation');
    const old = await readResearchFile(input.projectPath, 'ui.txt');
    await writeFile(join(data.project, 'ui.txt'), 'external-change');
    await expect(writer(input).execute({ path: 'ui.txt', expectedHash: old.hash, content: 'overwrite-ui' })).rejects.toThrow('file_version_changed');
    return 'DONE_WITHOUT_FORWARDING_TOOL_ERRORS';
  });
  const result = await data.batch() as { status: string; results: { agent: string; writeFeedback?: unknown[] }[] };
  expect(result.status).toBe('incomplete');
  expect(result.results.find(call => call.agent === 'agy')!.writeFeedback).toMatchObject([{ code: 'write_scope_violation', path: 'business.txt' }, { code: 'file_version_changed', path: 'ui.txt' }]);
  expect((await data.service.list(data.source.sessionKey)).find(call => call.input.agent === 'agy')!.writeFeedback).toHaveLength(2);
  expect(await readFile(join(data.project, 'business.txt'), 'utf8')).toBe('old-business');
  expect(await readFile(join(data.project, 'ui.txt'), 'utf8')).toBe('external-change');
});

it('源取消传播到两项任务，结束后的旧工具闭包不能继续写入', async () => {
  const data = await fixture();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  data.handle(async () => { await barrier; return 'LATE'; });
  const pending = data.batch();
  try {
    await vi.waitFor(() => expect(data.sent).toHaveLength(2));
    data.abort.abort();
    const result = await pending as { results: { status: string }[] };
    expect(result.results.map(call => call.status)).toEqual(['cancelled', 'cancelled']);
    await expect(writer(data.sent[0]!).execute({ path: 'ui.txt', expectedHash: null, content: 'late' })).rejects.toThrow('结束或取消');
  } finally { release(); }
  expect(await readFile(join(data.project, 'ui.txt'), 'utf8')).toBe('old-ui');
});

it('活动批次阻止普通写入调用；全部结束后恢复直接调用', async () => {
  const data = await fixture();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  data.handle(async () => { await barrier; return 'DONE'; });
  const pending = data.batch();
  try {
    await vi.waitFor(() => expect(data.sent).toHaveLength(2));
    await expect(data.runtime.tools![0]!.execute({ agent: 'codex', mode: 'execute', prompt: '跨过批次写入' })).rejects.toThrow('project_write_busy');
    expect(data.sent).toHaveLength(2);
  } finally { release(); }
  await pending;
  expect(await data.runtime.tools![0]!.execute({ agent: 'codex', mode: 'execute', prompt: '集成验证' })).toMatchObject({ status: 'succeeded' });
});

it('权限、未准入 Gemini 或符号链接范围在派发前拒绝，不启动半批任务', async () => {
  const data = await fixture();
  const plan = data.service.tools({ ...data.source, permissionMode: 'plan' }, 'plan', data.abort.signal);
  await expect(plan.tools!.find(tool => tool.name === 'call_agents')!.execute({ tasks: data.tasks })).rejects.toThrow('计划模式');
  const provider = data.agents.get('agy');
  provider.getStatus = async () => ({ kind: 'agy', found: true, version: '9.9.9' });
  await expect(data.batch()).rejects.toThrow('尚未验证只读');
  provider.getStatus = async () => ({ kind: 'agy', found: true, version: '1.4.3' });
  await symlink('business.txt', join(data.project, 'alias.txt'));
  await expect(data.batch(data.tasks.map(task => ({ ...task, allowedPaths: task.agent === 'agy' ? ['alias.txt'] : task.allowedPaths })))).rejects.toThrow('符号链接');
  expect(data.sent).toHaveLength(0);
});
