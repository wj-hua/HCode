// 显式开启才调用真实 CLI；研究限制解除后用可丢弃项目验证原生命令和重启续聊，不触碰业务项目。
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { TurnOutcome } from '../../../shared/collaboration.js';
import { CodexSession } from '../../agents/codex/codexSession.js';
import { AppServerClient } from '../../agents/codex/appServerClient.js';
import { ClaudeSession } from '../../agents/claude/claudeSession.js';

const enabled = process.env.HCODE_NATIVE_CONTINUATION === '1';
const TIMEOUT_MS = 240_000;
const instructions = '当前由 HCode 普通对话续聊。之前研究和验收的只读、禁止命令、只回 JSON 限制仅适用于旧回合，不约束本轮；旧报告仍是参考。按本轮最新请求和当前权限继续，不擅自扩大用户授权。仅用于这次临时夹具验证：普通回复末尾写 HANDOFF_APPLIED，证明本条系统交接已经送达。';
const researchPrompt = '这是一次研究回合，只回复 JSON {"summary":"源码静态参考，未执行测试"}；此回合不运行命令、不写文件。';
const ordinaryPrompt = '现在继续普通协作。请实际执行 node check.mjs，报告实际输出，并结合先前静态报告说明新证据。不修改 check.mjs。不沿用上一研究回合的格式要求。';

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'hcode-handoff-'));
  const source = "import fs from 'node:fs'; fs.writeFileSync('normal-proof.txt','ORDINARY_COMMAND_PASSED'); console.log('ORDINARY_COMMAND_PASSED');\n";
  await writeFile(join(root, 'check.mjs'), source);
  return { root, source };
}
async function evidence(name: string, value: unknown) {
  const directory = process.env.HCODE_NATIVE_CONTINUATION_EVIDENCE;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2));
}

it.skipIf(!enabled)('Codex 研究→普通命令→重启恢复均保留原线程、参考和最新授权', async () => {
  const fixture = await project();
  const createClient = () => new AppServerClient(async () => ({ path: '/opt/homebrew/bin/codex', env: process.env as Record<string, string>, experimentalApi: true }), 'handoff');
  let client = createClient();
  const items: Record<string, unknown>[] = [], outcomes: TurnOutcome[] = [];
  let resolve: ((outcome: TurnOutcome) => void) | undefined;
  let session: CodexSession;
  const host = { client, emitRows: () => {}, emitState: () => {}, emitPermission: () => {}, emitPermissionResolved: () => {}, onThreadId: () => {}, onTurnCompleted: () => {}, emitTurnOutcome: (outcome: TurnOutcome) => { outcomes.push(outcome); resolve?.(outcome); } };
  session = new CodexSession(host, { key: 'source', projectPath: fixture.root, permissionMode: 'read-only', research: { root: fixture.root, outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } } });
  const connect = () => {
    client.on('notification', (method, params) => { if (method === 'item/completed') items.push(params.item); session.handleNotification(method, params); });
    client.on('request', request => { if (!session.handleServerRequest(request)) client.respondError(request.id, '未授权验收工具'); });
  };
  connect();
  const send = async (text: string) => {
    const done = new Promise<TurnOutcome>(callback => { resolve = callback; });
    await session.send(text);
    const result = await done;
    expect(result.outcome).toBe('succeeded');
    return result;
  };
  try {
    const report = await send(researchPrompt);
    await session.configureResearch(undefined); await session.setPermissionMode('full-access'); await session.configureContinuation(instructions);
    const normal = await send(ordinaryPrompt);
    expect(normal.text).toContain('HANDOFF_APPLIED');
    expect(normal.nativeSessionId).toBe(report.nativeSessionId);
    expect(await readFile(join(fixture.root, 'normal-proof.txt'), 'utf8')).toBe('ORDINARY_COMMAND_PASSED');
    expect(items.some(item => item.type === 'commandExecution')).toBe(true);
    session.close(); client.dispose(); client = createClient(); host.client = client;
    session = new CodexSession(host, { key: 'resumed-source', threadId: report.nativeSessionId, projectPath: fixture.root, permissionMode: 'full-access' });
    connect();
    await session.configureContinuation(instructions);
    const resumed = await send('继续核对：实际执行 node check.mjs，再说明先前报告与这次执行结果分别证明了什么。');
    expect(resumed.text).toContain('HANDOFF_APPLIED');
    expect(resumed.nativeSessionId).toBe(report.nativeSessionId);
    expect(await readFile(join(fixture.root, 'check.mjs'), 'utf8')).toBe(fixture.source);
    await evidence('codex', { outcomes, tools: items.filter(item => item.type === 'commandExecution'), sourceUnchanged: true, commandArtifact: 'ORDINARY_COMMAND_PASSED' });
  } finally { session.close(); client.dispose(); await rm(fixture.root, { recursive: true, force: true }); }
}, TIMEOUT_MS);

it.skipIf(!enabled)('Claude 研究结束后恢复原工具与系统追加，普通续聊实际执行命令', async () => {
  const fixture = await project();
  const outcomes: TurnOutcome[] = [];
  let resolve: ((outcome: TurnOutcome) => void) | undefined;
  const session = new ClaudeSession({ claudePath: join(process.env.HOME!, '.local/bin/claude'), env: process.env as Record<string, string>, emitRows: () => {}, emitState: () => {}, emitPermission: () => {}, emitPermissionResolved: () => {}, onSessionId: () => {}, onQuotaChanged: () => {}, onCommandsChanged: () => {}, emitTurnOutcome: outcome => { outcomes.push(outcome); resolve?.(outcome); } }, { key: 'claude-source', projectPath: fixture.root, permissionMode: 'default' });
  const send = async (text: string) => {
    const done = new Promise<TurnOutcome>(callback => { resolve = callback; });
    session.send(text);
    const result = await done;
    expect(result.outcome).toBe('succeeded');
    return result;
  };
  try {
    await session.configureResearch({ root: fixture.root });
    const report = await send(researchPrompt);
    await session.configureResearch(undefined); await session.setPermissionMode('bypassPermissions'); await session.configureContinuation(instructions);
    const normal = await send(ordinaryPrompt);
    expect(normal.text).toContain('HANDOFF_APPLIED');
    expect(normal.nativeSessionId).toBe(report.nativeSessionId);
    expect(await readFile(join(fixture.root, 'normal-proof.txt'), 'utf8')).toBe('ORDINARY_COMMAND_PASSED');
    expect(await readFile(join(fixture.root, 'check.mjs'), 'utf8')).toBe(fixture.source);
    await evidence('claude', { outcomes, sourceUnchanged: true, commandArtifact: 'ORDINARY_COMMAND_PASSED' });
  } finally { session.close(); await rm(fixture.root, { recursive: true, force: true }); }
}, TIMEOUT_MS);
