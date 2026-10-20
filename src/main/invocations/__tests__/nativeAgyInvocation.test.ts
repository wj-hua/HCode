// 显式开启的 agy 原生验收：只在临时项目读取、写入和续聊，验证真实模型与 MCP 研究角色。
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { ChatSendParams } from '../../../shared/types.js';
import type { AgentEvents } from '../../agents/types.js';
import { AgyAgent } from '../../agents/agy/agyAgent.js';
import { ClaudeAgent } from '../../agents/claude/claudeAgent.js';
import { CodexAgent } from '../../agents/codex/codexAgent.js';
import { AgentRegistry } from '../../agents/registry.js';
import { SessionExecutionService } from '../../sessions/sessionExecutionService.js';
import { InvocationRepository } from '../invocationRepository.js';
import { AgentInvocationService } from '../agentInvocationService.js';

const enabled = process.env.HCODE_NATIVE_AGY_INVOCATION === '1';
const TIMEOUT_MS = 240_000;

it.skipIf(!enabled)('agy/Gemini 原生只读与执行调用均可续接同一会话，结果返回统一工具', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hcode-native-agy-invoke-'));
  const project = join(root, 'project'); await mkdir(project);
  const seed = randomUUID(); await writeFile(join(project, 'seed.txt'), seed);
  let execution: SessionExecutionService;
  const events: AgentEvents = {
    turnOutcome: event => execution.acceptOutcome(event),
    state: event => { if (event.sessionId) execution.observeIdentity(event.sessionKey, event.agent, event.sessionId); },
    rows: () => {}, commands: () => {}, permission: () => {}, permissionResolved: () => {}, indexChanged: () => {}, quotaStale: () => {},
  };
  const env = () => process.env as Record<string, string>;
  const provider = new AgyAgent(events, env, () => '', join(root, 'research'));
  const agents = new AgentRegistry({ agy: provider, claude: new ClaudeAgent(events, env, () => ''), codex: new CodexAgent(events, env, () => '', root) });
  execution = new SessionExecutionService({ prepare: async input => input, send: input => agents.send(input), interrupt: async key => { await agents.bySessionKey(key)?.interrupt(key); }, failedToSend: () => {}, finishedSending: () => {} });
  const repository = new InvocationRepository(join(root, 'records'));
  const service = new AgentInvocationService(repository, execution, () => {}, () => '', agents);
  const source: ChatSendParams = { agent: 'claude', sessionKey: randomUUID(), projectPath: project, permissionMode: 'bypassPermissions', text: '委派 Gemini' };
  const abort = new AbortController();
  const call = service.tools(source, randomUUID(), abort.signal).tools![0]!;
  try {
    const model = (await provider.listModels()).find(entry => entry.value.startsWith('gemini-'))?.value;
    expect(model).toBeTruthy();
    const read = await call.execute({ agent: 'agy', model, mode: 'read-only', prompt: '用宿主 read_file 工具读取 seed.txt，原样回复文件内容。不写文件，不执行命令。' }) as { invocationId: string; status: string; output: string; nativeSessionId: string };
    expect(read, JSON.stringify(read)).toMatchObject({ status: 'succeeded', output: expect.stringContaining(seed) });
    const continuedRead = await call.execute({ agent: 'agy', mode: 'read-only', continueInvocationId: read.invocationId, prompt: '请再次用宿主 read_file 读取 seed.txt，并原样回复内容。' });
    expect(continuedRead, JSON.stringify(continuedRead)).toMatchObject({ status: 'succeeded', nativeSessionId: read.nativeSessionId, output: expect.stringContaining(seed) });
    const write = await call.execute({ agent: 'agy', model, mode: 'execute', prompt: '读取 seed.txt 并把文件内容原样写入 child.txt，仅允许修改 child.txt。检查内容后回复 WRITE_DONE。不提交、不联网。' }) as { invocationId: string; status: string; nativeSessionId: string };
    expect(write, JSON.stringify(write)).toMatchObject({ status: 'succeeded' });
    expect((await readFile(join(project, 'child.txt'), 'utf8')).trim()).toBe(seed);
    const continuedWrite = await call.execute({ agent: 'agy', mode: 'execute', continueInvocationId: write.invocationId, prompt: '继续之前的任务。仅用读取工具读取 child.txt，原样回复内容，不修改任何文件。' });
    expect(continuedWrite, JSON.stringify(continuedWrite)).toMatchObject({ status: 'succeeded', nativeSessionId: write.nativeSessionId, output: expect.stringContaining(seed) });
    expect(await service.list(source.sessionKey)).toHaveLength(4);
  } finally { abort.abort(); service.dispose(); execution.dispose(); agents.dispose(); await rm(root, { recursive: true, force: true }); }
}, TIMEOUT_MS);
