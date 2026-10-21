// 显式启用的原生建议验收：只发送两轮普通对话，不请求建议生成工具或额外模型回合。
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { TurnOutcome } from '../../../shared/collaboration.js';
import type { ChatPromptSuggestionEvent } from '../../../shared/types.js';
import { ClaudeSession } from '../claude/claudeSession.js';

const enabled = process.env.HCODE_NATIVE_PROMPT_SUGGESTIONS === '1';
const TIMEOUT_MS = 180_000;
const SUGGESTION_WAIT_MS = 30_000;

it.skipIf(!enabled)('真实 Claude 在 result 之后返回原生输入建议，仍保持两轮执行与空闲终态', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hcode-native-suggestion-')));
  const outcomes: TurnOutcome[] = [], suggestions: ChatPromptSuggestionEvent[] = [];
  let receive!: (event: TurnOutcome) => void;
  const session = new ClaudeSession({ claudePath: join(process.env.HOME!, '.local/bin/claude'), env: process.env as Record<string, string>, emitRows: () => {}, emitState: () => {}, emitPermission: () => {}, emitPermissionResolved: () => {}, onSessionId: () => {}, onCommandsChanged: () => {}, onQuotaChanged: () => {}, emitTurnOutcome: event => { outcomes.push(event); receive(event); }, emitPromptSuggestion: event => suggestions.push(event) }, { key: randomUUID(), projectPath: root, permissionMode: 'default' });
  const send = async (prompt: string) => {
    const completed = new Promise<TurnOutcome>(resolve => { receive = resolve; });
    session.send(prompt);
    const result = await completed;
    expect(result.outcome, result.error).toBe('succeeded');
    return result;
  };
  try {
    await send('我想做一个只显示当前时间的 HTML 原型。先不创建文件、不使用工具，请用两句话确认一个最简单的实现方案。');
    const last = await send('方案确认，先按两条列出接下来创建页面的实现步骤。仍不创建文件、不使用工具；下一轮我再让你开始实现。请简短回复。');
    await vi.waitFor(() => expect(suggestions.some(event => event.turnId === last.executionTurnId && event.suggestion)).toBe(true), { timeout: SUGGESTION_WAIT_MS });
    expect(outcomes).toHaveLength(2); expect(session.isBusy).toBe(false);
    expect(suggestions.find(event => event.suggestion)?.sessionId).toBe(last.nativeSessionId);
  } finally { session.close(); await rm(root, { recursive: true, force: true }); }
}, TIMEOUT_MS);
