// 显式启用的原生并行验收：真实 Gemini/Codex 仅在临时项目经宿主白名单写入。
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { AgentInvocation } from '../../../shared/agentInvocation.js';
import type { TurnOutcome } from '../../../shared/collaboration.js';
import type { AgentEvents } from '../../agents/types.js';
import { AgentRegistry } from '../../agents/registry.js';
import { AgyAgent } from '../../agents/agy/agyAgent.js';
import { ClaudeAgent } from '../../agents/claude/claudeAgent.js';
import { CodexAgent } from '../../agents/codex/codexAgent.js';
import { SessionExecutionService } from '../../sessions/sessionExecutionService.js';
import { InvocationRepository } from '../invocationRepository.js';
import { AgentInvocationService } from '../agentInvocationService.js';

const enabled = process.env.HCODE_NATIVE_PARALLEL_INVOCATION === '1';
const TIMEOUT_MS = 240_000;

it.skipIf(!enabled)('真实 Claude 按冲突反馈调整分工，再统筹 Gemini 与 Codex 并行写入', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hcode-native-parallel-')));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'protected.txt'), 'DO_NOT_CHANGE');
  let execution: SessionExecutionService;
  let service: AgentInvocationService;
  const sourceKey = randomUUID();
  let settleSource!: (outcome: TurnOutcome) => void;
  const sourceOutcome = new Promise<TurnOutcome>(resolve => { settleSource = resolve; });
  const updates: AgentInvocation[] = [], starts: number[] = [], ends: number[] = [];
  const toolCalls: { name: string; input: Record<string, unknown>; error?: string }[] = [];
  const events: AgentEvents = {
    turnOutcome: event => { if (event.sessionKey === sourceKey) settleSource(event); else ends.push(Date.now()); execution.acceptOutcome(event); },
    state: event => { if (event.sessionId) execution.observeIdentity(event.sessionKey, event.agent, event.sessionId); },
    rows: () => {}, commands: () => {}, permission: () => {}, permissionResolved: () => {}, indexChanged: () => {}, quotaStale: () => {},
  };
  const env = () => process.env as Record<string, string>;
  const agy = new AgyAgent(events, env, () => '', join(root, 'research'));
  const agents = new AgentRegistry({ agy, claude: new ClaudeAgent(events, env, () => ''), codex: new CodexAgent(events, env, () => '', root) });
  execution = new SessionExecutionService({ prepare: async input => input, send: input => { if (input.sessionKey !== sourceKey) starts.push(Date.now()); return agents.send(input); }, interrupt: async key => { await agents.bySessionKey(key)?.interrupt(key); }, failedToSend: () => {}, finishedSending: () => {}, ordinaryTools: (params, turnId, signal) => {
    const runtime = service.tools(params, turnId, signal);
    return { ...runtime, tools: runtime.tools!.map(tool => ({ ...tool, execute: async input => {
      const call = { name: tool.name, input } as typeof toolCalls[number]; toolCalls.push(call);
      try { return await tool.execute(input); } catch (error) { call.error = String(error); throw error; }
    } })) };
  } });
  service = new AgentInvocationService(new InvocationRepository(join(root, 'records')), execution, call => updates.push(call), () => '', agents);
  const abort = new AbortController();
  try {
    const models = await agy.listModels();
    const model = models.find(entry => /^gemini-.*flash-low$/.test(entry.value))?.value ?? models.find(entry => entry.value.startsWith('gemini-'))?.value;
    expect(model).toBeTruthy();
    const prompt = (path: string, content: string) => `这是宿主写入范围的临时验收。严格只做三件事，不执行命令、不联网、不读取其他文件：1. 调用宿主 write_file，尝试将 protected.txt 写为 WRONG，expectedHash=null，这一步必须被拒绝；不要重试。2. 调用宿主 write_file 创建 ${path}，content 恰好为 ${content}，expectedHash=null。3. 用 read_file 核对 ${path}，然后只回复 DONE 和两次写入的真实结果。`;
    const tasks = [
      { taskKey: 'ui', agent: 'agy', model, prompt: prompt('ui.txt', 'UI_NATIVE'), allowedPaths: ['ui.txt'] },
      { taskKey: 'business', agent: 'codex', prompt: prompt('business.txt', 'BUSINESS_NATIVE'), allowedPaths: ['business.txt'] },
    ];
    const overlappingTasks = tasks.map(task => ({ ...task, allowedPaths: ['ui.txt'] }));
    await execution.send({ agent: 'claude', sessionKey: sourceKey, projectPath: project, permissionMode: 'bypassPermissions', text: `这是 HCode 冲突反馈与并行验收。第一步必须实际调用 mcp__hcode__call_agents，用下列参数原样提交一次，让宿主检测故意设置的范围重叠；不要在首次调用前自行修正。第二步根据工具返回的具体冲突反馈调整分工：UI 任务只负责 ui.txt，业务任务只负责 business.txt；核对并调整各自提示词与 allowedPaths 后，再用 call_agents 一次派发两项任务。不自己实现，不调用 call_agent、不执行命令、不修改任何文件、不增加审核或验证步骤。任务中尝试写 protected.txt 是额外的宿主权限验收，必须保留并让宿主拒绝，不能扩大 allowedPaths。等待第二批工具真实返回后，核对 writeFeedback 和 incomplete 状态，只简短回复 BATCH_FEEDBACK_RECEIVED、具体错误码与受保护文件路径。\n${JSON.stringify({ tasks: overlappingTasks })}` });
    const sourceResult = await sourceOutcome;
    expect(sourceResult, JSON.stringify(sourceResult)).toMatchObject({ outcome: 'succeeded', text: expect.stringContaining('BATCH_FEEDBACK_RECEIVED') });
    expect(sourceResult.text).toContain('write_scope_violation'); expect(sourceResult.text).toContain('protected.txt');
    const batches = toolCalls.filter(call => call.name === 'call_agents');
    expect(batches).toHaveLength(2);
    expect(batches[0]!.error).toContain('write_scope_conflict');
    expect(batches[1]!.input).toMatchObject({ tasks: expect.arrayContaining([
      expect.objectContaining({ taskKey: 'ui', allowedPaths: ['ui.txt'] }),
      expect.objectContaining({ taskKey: 'business', allowedPaths: ['business.txt'] }),
    ]) });
    const records = await service.list(sourceKey);
    expect(records).toHaveLength(2);
    expect(records.every(call => call.status === 'succeeded' && call.nativeSessionId && call.writeScope)).toBe(true);
    for (const call of records) expect(call.writeFeedback).toContainEqual(expect.objectContaining({ code: 'write_scope_violation', path: 'protected.txt' }));
    expect(starts).toHaveLength(2); expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
    expect(updates.filter(call => call.status === 'running').some(call => call.input.agent === 'agy')).toBe(true);
    expect(await readFile(join(project, 'ui.txt'), 'utf8')).toBe('UI_NATIVE');
    expect(await readFile(join(project, 'business.txt'), 'utf8')).toBe('BUSINESS_NATIVE');
    expect(await readFile(join(project, 'protected.txt'), 'utf8')).toBe('DO_NOT_CHANGE');
  } finally { abort.abort(); execution.cancelSource(sourceKey); service.dispose(); execution.dispose(); agents.dispose(); await rm(root, { recursive: true, force: true }); }
}, TIMEOUT_MS);
