// 显式启用的原生验收：临时目录中启动短时后台命令，核验真实 SDK 到宿主快照的闭环。
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ClaudeSession } from '../claude/claudeSession.js';
import type { ChatStateEvent } from '../../../shared/types.js';

const enabled = process.env.HCODE_NATIVE_BACKGROUND_TASKS === '1';
const TIMEOUT_MS = 180_000;
const TASK_MARKER = 'HCODE_BACKGROUND_TASK_DONE';

it.skipIf(!enabled)('真实后台命令在回复结束后继续展示，并收到完成结果', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hcode-background-')));
  const states: ChatStateEvent[] = [];
  const session = new ClaudeSession({
    claudePath: join(process.env.HOME!, '.local/bin/claude'), env: process.env as Record<string, string>,
    emitRows: () => {}, emitState: event => states.push(event), emitPermission: () => {},
    emitPermissionResolved: () => {}, onSessionId: () => {}, onCommandsChanged: () => {}, onQuotaChanged: () => {},
  }, { key: randomUUID(), projectPath: root, permissionMode: 'bypassPermissions' });
  try {
    session.send(`这是后台任务协议验收。只调用一次 Bash：command 为 sleep 12; printf '${TASK_MARKER}\\n'，run_in_background=true。立即回复“已启动”并结束回复，不等待、不查询、不使用其他工具、不读取文件。完成通知到达时只回复“完成”。`);
    await vi.waitFor(() => expect(states.some(state => state.state === 'idle' && state.backgroundTasks === 1)).toBe(true), { timeout: TIMEOUT_MS / 2 });
    await vi.waitFor(() => expect(states.at(-1)?.backgroundTaskDetails?.some(task => task.status === 'completed')).toBe(true), { timeout: TIMEOUT_MS / 2 });
    const finished = states.at(-1)!;
    expect(finished.backgroundTasks).toBeUndefined();
    expect(finished.backgroundTaskDetails?.find(task => task.status === 'completed')?.outputFile).toBeTruthy();
  } finally {
    session.close();
    await rm(root, { recursive: true, force: true });
  }
}, TIMEOUT_MS);
