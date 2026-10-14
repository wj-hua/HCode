// 显式开启的真实 CLI 闭环；临时项目验证子 AI 写入后源 AI 在同一回合继续，不碰业务项目。
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { AgentKind } from '../../../shared/types.js';
import type { TurnOutcome } from '../../../shared/collaboration.js';
import type { AgentInvocation } from '../../../shared/agentInvocation.js';
import type { AgentEvents, AgentProvider } from '../../agents/types.js';
import { ClaudeAgent } from '../../agents/claude/claudeAgent.js';
import { CodexAgent } from '../../agents/codex/codexAgent.js';
import { AgentRegistry } from '../../agents/registry.js';
import { SessionExecutionService } from '../../sessions/sessionExecutionService.js';
import { InvocationRepository } from '../invocationRepository.js';
import { AgentInvocationService } from '../agentInvocationService.js';
const enabled = process.env.HCODE_NATIVE_INVOCATION === '1';
const TIMEOUT_MS = 240_000;
it.skipIf(!enabled).each(['claude', 'codex'] as const)('%s 普通消息实际调用另一 AI 并收到结果后在同一原生回合继续', async sourceAgent => {
  const root = await mkdtemp(join(tmpdir(), 'hcode-native-invocation-'));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'seed.txt'), 'SEED_FOR_NATIVE_INVOCATION');
  let execution: SessionExecutionService;
  let invocations: AgentInvocationService;
  const calls: AgentInvocation[] = [], outcomes: TurnOutcome[] = [];
  const sourceKey = randomUUID();
  let resolveSource!: (outcome: TurnOutcome) => void;
  let sourceDone = new Promise<TurnOutcome>(resolve => { resolveSource = resolve; });
  let toolsEnabled = sourceAgent === 'codex';
  const events: AgentEvents = {
    turnOutcome: result => { outcomes.push(result); execution.acceptOutcome(result); if (result.sessionKey === sourceKey) resolveSource(result); },
    state: event => { if (event.sessionId) execution.observeIdentity(event.sessionKey, event.agent, event.sessionId); },
    rows: () => {}, commands: () => {}, permission: () => {}, permissionResolved: () => {}, indexChanged: () => {}, quotaStale: () => {},
  };
  const env = () => process.env as Record<string, string>;
  const agents = new AgentRegistry({ claude: new ClaudeAgent(events, env, () => join(homedir(), '.local/bin/claude')), codex: new CodexAgent(events, env, () => '/opt/homebrew/bin/codex', 'native-invocation') } as unknown as Record<AgentKind, AgentProvider>);
  execution = new SessionExecutionService({ prepare: async params => params, send: params => agents.send(params), interrupt: async key => { await agents.bySessionKey(key)?.interrupt(key); }, failedToSend: () => {}, finishedSending: () => {}, ordinaryTools: (params, id, signal) => toolsEnabled ? invocations.tools(params, id, signal) : undefined });
  invocations = new AgentInvocationService(new InvocationRepository(join(root, 'records')), execution, call => calls.push(call), () => '');
  const childAgent = sourceAgent === 'claude' ? 'codex' : 'claude';
  try {
    let originalIdentity: string | undefined;
    if (sourceAgent === 'claude') {
      await execution.send({ agent: sourceAgent, sessionKey: sourceKey, projectPath: project, permissionMode: 'bypassPermissions', text: '这一步不使用工具，只回复 BEFORE_HOSTED_TOOL。' });
      const existing = await sourceDone;
      expect(existing.outcome).toBe('succeeded'); originalIdentity = existing.nativeSessionId;
      toolsEnabled = true;
      sourceDone = new Promise<TurnOutcome>(resolve => { resolveSource = resolve; });
    }
    await execution.send({ agent: sourceAgent, sessionKey: sourceKey, projectPath: project, permissionMode: sourceAgent === 'claude' ? 'bypassPermissions' : 'full-access', text: `请实际使用 HCode call_agent 工具调用 ${childAgent}，不是写一份转交说明。让它在当前项目读取 seed.txt，然后创建 child-proof.txt，内容恰好为 CHILD_REAL，确认文件内容后回复 CHILD_FINISHED。由你组织这次调用的完整 prompt，mode=execute，不要自己完成子 AI 的工作。等待工具的真实 status=succeeded 之后，你再实际创建 source-proof.txt，内容恰好为 SOURCE_CONTINUED；这一步要由你完成。最后只回复 SOURCE_AFTER_CHILD 和子 AI 返回的标记。全部工作限于这个临时项目，不联网、不提交。` });
    const result = await sourceDone;
    expect(result.outcome, JSON.stringify({ result, calls })).toBe('succeeded');
    if (originalIdentity) expect(result.nativeSessionId).toBe(originalIdentity);
    expect(result.text).toContain('SOURCE_AFTER_CHILD');
    expect(result.text).toContain('CHILD_FINISHED');
    expect(await readFile(join(project, 'child-proof.txt'), 'utf8')).toBe('CHILD_REAL');
    expect(await readFile(join(project, 'source-proof.txt'), 'utf8')).toBe('SOURCE_CONTINUED');
    expect(calls.filter(call => call.status === 'succeeded')).toHaveLength(1);
    expect(calls[0]?.input.agent).toBe(childAgent);
    expect(outcomes.find(outcome => outcome.sessionKey !== sourceKey)?.nativeSessionId).toBeTruthy();
    if (process.env.HCODE_NATIVE_INVOCATION_EVIDENCE) {
      await mkdir(process.env.HCODE_NATIVE_INVOCATION_EVIDENCE, { recursive: true });
      await writeFile(join(process.env.HCODE_NATIVE_INVOCATION_EVIDENCE, `${sourceAgent}.json`), JSON.stringify({ calls, outcomes }, null, 2));
    }
  } finally { execution.dispose(); invocations.dispose(); agents.dispose(); await rm(root, { recursive: true, force: true }); }
}, TIMEOUT_MS);
