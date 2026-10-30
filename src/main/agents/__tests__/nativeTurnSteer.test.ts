// 显式启用的真实 CLI 插话验收：在第一个命令运行时插话，要求消息并入同一回合并改变后续行为。
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { TurnOutcome } from '../../../shared/collaboration.js';
import type { ConversationRow } from '../../../shared/types.js';
import { applyRowOps } from '../../../renderer/app/rows.js';
import { findExecutable } from '../../util/locateCli.js';
import { ClaudeSession } from '../claude/claudeSession.js';
import { AppServerClient } from '../codex/appServerClient.js';
import { CodexSession } from '../codex/codexSession.js';

const enabled = process.env.HCODE_NATIVE_TURN_STEER === '1';
const TIMEOUT_MS = 240_000;
const PROMPT = 'Run the shell command `sleep 5 && echo one`, then separately `sleep 5 && echo two`, then separately `sleep 5 && echo three`. One command per tool call, sequentially. Then reply with a one-line summary.';
const STEER = 'Change of plan: skip any remaining commands and end your summary with the word BANANA.';

/** 第一个工具开始运行后插话；返回插话结果、该回合的全部行与终态。 */
async function steerDuringFirstTool(start: () => void, steer: (text: string) => Promise<unknown>, rows: () => ConversationRow[], completed: Promise<TurnOutcome>) {
  start();
  await vi.waitFor(() => expect(rows().some(row => row.kind === 'toolCall')).toBe(true), { timeout: 60_000, interval: 200 });
  const delivered = await steer(STEER);
  const outcome = await completed;
  return { delivered, outcome, rows: rows() };
}

function expectSteeredTurn(result: Awaited<ReturnType<typeof steerDuringFirstTool>>) {
  expect(result.delivered).toEqual({ delivered: true });
  expect(result.outcome.outcome, result.outcome.error).toBe('succeeded');
  const users = result.rows.filter(row => row.kind === 'userInput');
  expect(users).toHaveLength(2);
  expect(users[1]).toMatchObject({ text: STEER, guided: true, turnId: users[0]!.turnId });
  expect(result.rows.filter(row => row.kind === 'turnHeader')).toHaveLength(1);
  expect(result.outcome.text).toContain('BANANA');
}

it.skipIf(!enabled)('真实 Claude 在工具间隙并入插话，同一回合内改变后续行为', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hcode-native-steer-claude-')));
  let rows: ConversationRow[] = [];
  let receive!: (event: TurnOutcome) => void;
  const completed = new Promise<TurnOutcome>(resolve => { receive = resolve; });
  const session = new ClaudeSession({ claudePath: process.env.HCODE_CLAUDE_PATH ?? join(process.env.HOME!, '.local/bin/claude'), env: process.env as Record<string, string>, emitRows: (_key, ops) => { rows = applyRowOps(rows, ops); }, emitState: () => {}, emitPermission: () => {}, emitPermissionResolved: () => {}, onSessionId: () => {}, onCommandsChanged: () => {}, onQuotaChanged: () => {}, emitTurnOutcome: event => receive(event) }, { key: randomUUID(), projectPath: root, permissionMode: 'bypassPermissions', model: 'sonnet' });
  try {
    expectSteeredTurn(await steerDuringFirstTool(() => session.send(PROMPT), text => session.steer(text), () => rows, completed));
  } finally { session.close(); await rm(root, { recursive: true, force: true }); }
}, TIMEOUT_MS);

it.skipIf(!enabled)('真实 Codex 通过 turn/steer 追加输入，回显写入同一回合', async () => {
  const executable = findExecutable('codex', process.env, process.env.HCODE_CODEX_PATH);
  if (!executable) throw new Error('未找到 Codex 验收程序');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hcode-native-steer-codex-')));
  let rows: ConversationRow[] = [];
  let receive!: (event: TurnOutcome) => void;
  const completed = new Promise<TurnOutcome>(resolve => { receive = resolve; });
  const client = new AppServerClient(async () => ({ path: executable, env: process.env as Record<string, string> }), 'turn-steer-validation');
  const session = new CodexSession({ client, emitRows: (_key, ops) => { rows = applyRowOps(rows, ops); }, emitState: () => {}, emitPermission: () => {}, emitPermissionResolved: () => {}, onThreadId: () => {}, onTurnCompleted: () => {}, emitTurnOutcome: event => receive(event) }, { key: randomUUID(), projectPath: root, permissionMode: 'full-access' });
  session.effort = 'low';
  client.on('notification', (method, params) => session.handleNotification(method, params));
  try {
    expectSteeredTurn(await steerDuringFirstTool(() => void session.send(PROMPT), text => session.steer(text), () => rows, completed));
  } finally { session.close(); client.dispose(); await rm(root, { recursive: true, force: true }); }
}, TIMEOUT_MS);
