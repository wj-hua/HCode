// 代码草案测试使用真实项目、沙箱验证和持久化；只替换外部 CLI 传输。
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { AgentKind } from '../../../shared/types.js';
import type { AgentProvider, AgentSendParams } from '../../agents/types.js';
import type { CollaborationSnapshot } from '../../../shared/collaboration.js';
import { AgentRegistry } from '../../agents/registry.js';
import { SessionExecutionService } from '../../sessions/sessionExecutionService.js';
import { researchTools } from '../../sessions/researchRuntime.js';
import { CollaborationRepository } from '../collaborationRepository.js';
import { CollaborationService } from '../collaborationService.js';
import { CodeDraftService } from '../drafts/codeDraftService.js';
const exec = promisify(execFile);
export async function codeDraftFixture() {
  const root = await mkdtemp(join(tmpdir(), 'hcode-code-plan-')), project = join(root, 'project'), sourceKey = randomUUID();
  await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"private":true,"type":"module"}');
  for (const path of ['value.mjs', 'other.mjs']) await writeFile(join(project, path), 'export const value = 0;\n');
  await writeFile(join(project, 'value.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './value.mjs';\nimport { value as other } from './other.mjs';\ntest('both values',()=>{assert.ok(value >= 0);assert.ok(other >= 0);});\n");
  await exec('git', ['init', project]); await exec('git', ['-C', project, 'add', '.']);
  await exec('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=test@invalid.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline']);
  let latest: CollaborationSnapshot | undefined, version = 'fixture-1';
  const agents = new AgentRegistry(Object.fromEntries((['claude', 'codex', 'agy'] as const).map(kind => [kind, { kind, getStatus: async () => ({ kind, found: true, version: kind === 'codex' ? '0.162.0' : kind === 'agy' ? '1.3.3' : version }), listModels: async () => [{ value: 'gemini-fixture', label: 'Gemini' }], hasSession: () => true, endResearch: async () => {} }])) as unknown as Record<AgentKind, AgentProvider>);
  let proposal = { confidence: 'ready', summary: '两项独立任务，无写入重叠。', sources: ['value.mjs', 'other.mjs'], tasks: ['value.mjs', 'other.mjs'].map((path, index) => ({ requestKey: `task-${index + 1}`, name: `修改 ${path}`, objective: `将 ${path} 的常量设为 ${index + 1}，保留原测试`, reason: '目标指定的独立常量', allowedPaths: [path], dependsOn: [] as string[] })) };
  const send = vi.fn(async (input: AgentSendParams) => {
    const task = latest?.tasks.findLast(entry => entry.sessionKey === input.sessionKey);
    let text: string;
    if (!task) {
      for (const path of ['value.mjs', 'other.mjs']) await researchTools(input.research!).find(tool => tool.name === 'read_file')!.execute({ path });
      text = JSON.stringify(proposal);
    } else if (task.role === 'execution') {
      const path = input.agent === 'claude' ? 'value.mjs' : 'other.mjs', content = `export const value = ${input.agent === 'claude' ? 1 : 2};\n`;
      const file = await researchTools(input.research!).find(tool => tool.name === 'read_file')!.execute({ path }) as { hash: string };
      await input.research!.tools!.find(tool => tool.name === 'write_file')!.execute({ path, expectedHash: file.hash, content });
      text = JSON.stringify({ summary: '候选已修改，等待宿主检查', findings: [{ id: 'value', title: '常量', detail: '仅改本任务文件', evidence: [{ path, startLine: 1, endLine: 1, quote: content.trimEnd() }] }], limitations: ['待宿主检查'] });
    } else if (task.role === 'review') text = JSON.stringify({ verdict: 'approved', summary: '范围与宿主检查证据符合本任务', issues: [] });
    else text = '两项候选通过审查，尚未采纳，请逐项检查。';
    execution.acceptOutcome({ sessionKey: input.sessionKey, agent: input.agent, executionTurnId: input.executionTurnId!, nativeSessionId: `native-${input.sessionKey}`, outcome: 'succeeded', text });
    return { sessionKey: input.sessionKey };
  });
  const execution = new SessionExecutionService({ prepare: async input => input, send, interrupt: async () => {}, failedToSend: () => {}, finishedSending: () => {} });
  const repository = new CollaborationRepository(join(root, 'records'));
  const collaboration = new CollaborationService(repository, execution, agents, value => { latest = value; }, 'darwin');
  const drafts = new CodeDraftService(join(root, 'code-plans'), collaboration, execution, agents);
  const input = { initiator: { agent: 'claude' as const, sessionKey: sourceKey, projectPath: project, permissionMode: 'default' }, objective: '独立修改 value.mjs 和 other.mjs 并保留测试', backendPreferences: [{ agent: 'claude' as const }, { agent: 'codex' as const }] };
  return { root, project, drafts, collaboration, repository, execution, agents, send, input, setProposal: (value: typeof proposal) => { proposal = value; }, proposal: () => proposal, setVersion: (value: string) => { version = value; }, cleanup: async () => { drafts.dispose(); collaboration.dispose(); await rm(root, { recursive: true, force: true }); } };
}
