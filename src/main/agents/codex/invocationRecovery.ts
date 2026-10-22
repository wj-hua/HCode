// Codex 委派恢复的原生准入：读取实际线程状态与项目，不用重启后的空内存表推断旧任务已停止。
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { AppServerClient } from './appServerClient.js';

const threadState = z.object({ thread: z.object({ id: z.string(), cwd: z.string(), status: z.object({ type: z.string() }) }) });

/** attach 前允许尚未加载的历史线程；attach 后必须确认 idle 才能追加新回合。 */
export async function assertInvocationThreadIdle(client: AppServerClient, threadId: string, projectPath: string, attached: boolean) {
  const { thread } = threadState.parse(await client.request('thread/read', { threadId, includeTurns: false }));
  if (thread.id !== threadId || await realpath(thread.cwd) !== await realpath(projectPath)) throw new Error('Codex 原生会话身份或项目不匹配，不能恢复');
  if (thread.status.type === 'idle' || !attached && thread.status.type === 'notLoaded') return;
  throw new Error(`Codex 原生会话尚未确认空闲（${thread.status.type}），不能恢复或新建替代会话`);
}
