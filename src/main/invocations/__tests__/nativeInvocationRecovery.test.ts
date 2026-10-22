// 真实 CLI 验收：中断 Claude 委派的 Codex，重建宿主后只说“继续”，检查原生身份和最终产物。
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { TurnOutcome } from '../../../shared/collaboration.js';
import type { AgentInvocation } from '../../../shared/agentInvocation.js';
import type { AgentEvents } from '../../agents/types.js';
import { ClaudeAgent } from '../../agents/claude/claudeAgent.js';
import { CodexAgent } from '../../agents/codex/codexAgent.js';
import { AgyAgent } from '../../agents/agy/agyAgent.js';
import { AgentRegistry } from '../../agents/registry.js';
import { SessionExecutionService } from '../../sessions/sessionExecutionService.js';
import { InvocationRepository } from '../invocationRepository.js';
import { AgentInvocationService } from '../agentInvocationService.js';

const TIMEOUT_MS = 240_000;
const POLL_MS = 200;
const enabled = process.env.HCODE_NATIVE_INVOCATION_RECOVERY === '1';

function runtime(root: string) {
  const calls: AgentInvocation[] = [], outcomes: TurnOutcome[] = [];
  let execution: SessionExecutionService, invocations: AgentInvocationService;
  const events: AgentEvents = {
    turnOutcome: result => { outcomes.push(result); execution.acceptOutcome(result); },
    state: event => { if (event.sessionId) execution.observeIdentity(event.sessionKey, event.agent, event.sessionId); },
    rows: () => {}, commands: () => {}, permission: () => {}, permissionResolved: () => {}, indexChanged: () => {}, quotaStale: () => {},
  };
  const env = () => process.env as Record<string, string>;
  const agents = new AgentRegistry({ claude: new ClaudeAgent(events, env, () => join(homedir(), '.local/bin/claude')), codex: new CodexAgent(events, env, () => '/opt/homebrew/bin/codex', 'native-recovery'), agy: new AgyAgent(events, env, () => '', join(root, 'agy-research')) });
  execution = new SessionExecutionService({ prepare: async params => params, send: params => agents.send(params), interrupt: async key => { await agents.bySessionKey(key)?.interrupt(key); }, failedToSend: () => {}, finishedSending: () => {}, ordinaryTools: (params, id, signal) => invocations.tools(params, id, signal) });
  const repository = new InvocationRepository(join(root, 'records'));
  invocations = new AgentInvocationService(repository, execution, call => calls.push(call), () => '', agents);
  return { execution, invocations, agents, repository, calls, outcomes, dispose() { execution.dispose(); invocations.dispose(); agents.dispose(); } };
}

it.skipIf(!enabled)('重建宿主后 Claude 收到“继续”会恢复中断的原 Codex 线程并完成任务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hcode-native-recovery-'));
  const project = join(root, 'project'); await mkdir(project);
  const first = runtime(root);
  let second: ReturnType<typeof runtime> | undefined;
  const sourceKey = randomUUID();
  try {
    await first.execution.send({ agent: 'claude', sessionKey: sourceKey, projectPath: project, permissionMode: 'bypassPermissions', text: '请把这个任务委派给 Codex 执行，所有文件修改都由 Codex 完成：如果 ready.txt 不存在，先执行 shell 命令 printf READY > ready.txt; sleep 90。若 ready.txt 已存在，跳过等待。然后创建 done.txt，内容精确为 ORIGINAL_TASK_FINISHED。不要自行创建这些文件。调用若被中断，报告中断并等待我继续。' });
    await vi.waitFor(async () => expect(await readFile(join(project, 'ready.txt'), 'utf8')).toBe('READY'), { timeout: TIMEOUT_MS / 2, interval: POLL_MS });
    const checkpoint = (await first.repository.list()).find(call => call.input.agent === 'codex')!;
    expect(checkpoint.status).toBe('running');
    expect(checkpoint.nativeSessionId).toBeTruthy();
    const sourceId = first.execution.nativeSessionId(sourceKey, 'claude');
    expect(sourceId).toBeTruthy();
    first.execution.cancelSource(sourceKey);
    await first.agents.get('claude').interrupt(sourceKey);
    await vi.waitFor(async () => expect((await first.repository.load(checkpoint.id)).status).toBe('cancelled'), { timeout: TIMEOUT_MS / 4, interval: POLL_MS });
    first.dispose();
    // 恢复退出瞬间保存的 running 快照，复现应用没来得及写终态的重启。
    await first.repository.save(checkpoint);
    second = runtime(root);
    const resumedKey = randomUUID();
    await second.execution.send({ agent: 'claude', sessionKey: resumedKey, resumeSessionId: sourceId, projectPath: project, permissionMode: 'bypassPermissions', text: '继续' });
    await vi.waitFor(() => expect(second!.outcomes.some(outcome => outcome.sessionKey === resumedKey)).toBe(true), { timeout: TIMEOUT_MS / 2, interval: POLL_MS });
    expect(second.outcomes.find(outcome => outcome.sessionKey === resumedKey)?.outcome).toBe('succeeded');
    const recovered = (await second.repository.list()).filter(call => call.id !== checkpoint.id);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ nativeSessionId: checkpoint.nativeSessionId, status: 'succeeded', input: { continueInvocationId: checkpoint.id } });
    expect(await readFile(join(project, 'done.txt'), 'utf8')).toBe('ORIGINAL_TASK_FINISHED');
  } finally { first.dispose(); second?.dispose(); await rm(root, { recursive: true, force: true }); }
}, TIMEOUT_MS);
