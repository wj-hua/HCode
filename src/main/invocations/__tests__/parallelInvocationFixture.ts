// 仅替换原生 Provider 传输；真实执行服务、文件工具、权限规则和落盘记录保持接通。
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentInvocation, ParallelInvocationTask } from '../../../shared/agentInvocation.js';
import type { ChatSendParams, AgentKind } from '../../../shared/types.js';
import type { AgentProvider, AgentSendParams } from '../../agents/types.js';
import { AgentRegistry } from '../../agents/registry.js';
import { SessionExecutionService } from '../../sessions/sessionExecutionService.js';
import { InvocationRepository } from '../invocationRepository.js';
import { AgentInvocationService } from '../agentInvocationService.js';

export async function parallelInvocationFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hcode-scoped-invoke-')));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'ui.txt'), 'old-ui'); await writeFile(join(project, 'business.txt'), 'old-business');
  const sent: AgentSendParams[] = [], updates: AgentInvocation[] = [], transports: Promise<unknown>[] = [];
  const source: ChatSendParams = { agent: 'claude', sessionKey: randomUUID(), resumeSessionId: 'source-native', projectPath: project, permissionMode: 'bypassPermissions', text: 'Gemini 写 UI，Codex 写业务' };
  const agents = new AgentRegistry(Object.fromEntries((['claude', 'codex', 'agy'] as const).map(kind => [kind, {
    kind, getStatus: async () => ({ kind, found: true, version: kind === 'agy' ? '1.4.3' : '0.163.0' }),
    listModels: async () => [{ value: kind === 'agy' ? 'gemini-fixture' : 'selected-model', label: 'Fixture' }],
  }])) as Record<AgentKind, AgentProvider>);
  let handler: (input: AgentSendParams) => Promise<string> = async () => 'DONE';
  const execution = new SessionExecutionService({ prepare: async input => input, failedToSend: () => {}, finishedSending: () => {}, interrupt: async key => {
    const input = sent.find(entry => entry.sessionKey === key)!;
    execution.acceptOutcome({ sessionKey: key, agent: input.agent, executionTurnId: input.executionTurnId!, outcome: 'cancelled', text: '' });
  }, send: async input => {
    sent.push(input);
    transports.push(handler(input).then(text => execution.acceptOutcome({ sessionKey: input.sessionKey, agent: input.agent, executionTurnId: input.executionTurnId!, nativeSessionId: `native-${input.sessionKey}`, outcome: 'succeeded', text }), error => execution.acceptOutcome({ sessionKey: input.sessionKey, agent: input.agent, executionTurnId: input.executionTurnId!, outcome: 'failed', error: String(error), text: '' })));
    return { sessionKey: input.sessionKey };
  } });
  const service = new AgentInvocationService(new InvocationRepository(join(root, 'records')), execution, call => updates.push(call), agent => agent === 'agy' ? 'gemini-fixture' : 'selected-model', agents);
  const abort = new AbortController();
  const runtime = service.tools(source, 'source-turn', abort.signal);
  const tasks: ParallelInvocationTask[] = [{ taskKey: 'ui', agent: 'agy', prompt: '只实现 UI 文件，业务文件只读', allowedPaths: ['ui.txt'] }, { taskKey: 'business', agent: 'codex', prompt: '只实现业务文件，UI 文件只读', allowedPaths: ['business.txt'] }];
  return { root, project, source, agents, execution, service, abort, runtime, tasks, sent, updates,
    handle: (next: typeof handler) => { handler = next; },
    batch: (input = tasks) => runtime.tools!.find(tool => tool.name === 'call_agents')!.execute({ tasks: input }),
    cleanup: async () => { abort.abort(); service.dispose(); execution.dispose(); await Promise.all(transports); await rm(root, { recursive: true, force: true }); },
  };
}
