// 输入区上方的原生后台任务摘要与详情；生命周期由主进程提供，展开状态留在当前会话。
import { ChevronRightIcon, CircleCheckIcon, CircleHelpIcon, CircleStopIcon, CircleXIcon, LoaderIcon, TerminalIcon } from 'lucide-react';
import { BACKGROUND_TASK_STATUS_LABELS, type BackgroundTask } from '@hcode/shared/backgroundTasks';
import type { ConversationRow } from '@hcode/shared/types';
import { cn } from '@/components/lib/utils.js';
import { Button } from '@/components/ui/button.js';
import { toast } from '@/components/ui/toast.js';
import { useState } from 'react';
import { hcode } from '../bridge';
import type { Conversation } from '../store/appStore';

const STATUS_ICONS = {
  running: LoaderIcon, ended: CircleHelpIcon, completed: CircleCheckIcon,
  failed: CircleXIcon, stopped: CircleStopIcon, interrupted: CircleHelpIcon,
};

/** 只显示与原生 tool_use_id 精确匹配的命令，不扫描模型文字或其他任务输出。 */
function taskRow(task: BackgroundTask, rows: readonly ConversationRow[]) {
  if (!task.toolUseId) return undefined;
  return rows.find(item => item.kind === 'toolCall' && item.toolCallId === task.toolUseId);
}

function isMonitor(task: BackgroundTask, rows: readonly ConversationRow[]): boolean {
  const row = taskRow(task, rows);
  return row?.kind === 'toolCall' && row.toolName === 'Monitor';
}

function taskCommand(task: BackgroundTask, rows: readonly ConversationRow[]): string | undefined {
  const row = taskRow(task, rows);
  if (row?.kind !== 'toolCall' || !row.input || typeof row.input !== 'object' || !('command' in row.input)) return undefined;
  return typeof row.input.command === 'string' ? row.input.command : undefined;
}

function BackgroundTaskItem({ task, rows, sessionKey, canStop }: { task: BackgroundTask; rows: readonly ConversationRow[]; sessionKey?: string; canStop: boolean }) {
  const Icon = STATUS_ICONS[task.status];
  const command = taskCommand(task, rows);
  const monitor = isMonitor(task, rows);
  const [stopping, setStopping] = useState(false);
  async function stop() {
    if (!sessionKey || stopping) return;
    setStopping(true);
    try { await hcode.invoke('chat:stopBackgroundTask', sessionKey, task.id); }
    catch (error) { toast(`停止任务失败：${error instanceof Error ? error.message : String(error)}`, { variant: 'warning' }); }
    finally { setStopping(false); }
  }
  return (
    <li className="space-y-1.5 py-2">
      <div className="flex items-start gap-2">
        <Icon aria-hidden="true" className={cn('mt-0.5 size-3.5 shrink-0', task.status === 'running' && 'animate-spin motion-reduce:animate-none', task.status === 'failed' && 'text-destructive', task.status === 'completed' && 'text-success')} />
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words font-medium">{task.description}</p>
          <p className="text-foreground-subtle">{monitor && task.status === 'running' ? '监视中' : BACKGROUND_TASK_STATUS_LABELS[task.status]}{monitor && task.status !== 'running' ? ' · 监视任务' : ''}</p>
        </div>
        {canStop && sessionKey && task.status === 'running' ? <Button type="button" variant="secondary" size="sm" disabled={stopping} onClick={() => void stop()} aria-label={`${monitor ? '停止监视' : '停止任务'}：${task.description}`}>{stopping ? '正在停止…' : monitor ? '停止监视' : '停止任务'}</Button> : null}
      </div>
      {task.summary ? <p className="whitespace-pre-wrap break-words">{task.summary}</p> : null}
      {command ? <pre aria-label="执行命令" className="max-h-32 overflow-auto rounded-md bg-background p-2 font-mono text-ui-xs whitespace-pre-wrap break-all">{command}</pre> : null}
      {task.outputFile ? <p className="break-all text-foreground-subtle">输出文件：<span className="select-text font-mono">{task.outputFile}</span></p> : null}
    </li>
  );
}

export function BackgroundTaskPanel({ conversation }: { conversation: Pick<Conversation, 'viewId' | 'agent' | 'sessionKey' | 'backgroundTaskDetails' | 'rows'> }) {
  const tasks = conversation.backgroundTaskDetails ?? [];
  if (!tasks.length) return null;
  const running = tasks.filter(task => task.status === 'running');
  const latest = running[0] ?? tasks.at(-1)!;
  const current = `${latest.status === 'running' && isMonitor(latest, conversation.rows) ? '监视中' : BACKGROUND_TASK_STATUS_LABELS[latest.status]} · ${latest.description}`;
  const monitors = running.filter(task => isMonitor(task, conversation.rows)).length;
  const summary = monitors ? `${running.length - monitors} 项任务运行中 · ${monitors} 项监视中` : `${running.length} 项运行中`;
  const ordered = [...running, ...tasks.filter(task => task.status !== 'running').reverse()];

  return (
    <section aria-label="后台任务" className="mb-2 rounded-xl border border-border/60 bg-surface">
      <details key={conversation.viewId} className="group/background-tasks">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-ui-sm outline-none hover:bg-surface-hover active:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <TerminalIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1" role="status" aria-live="polite" aria-atomic="true">
            <span className="block font-medium">后台任务 · {summary}</span>
            <span className="block truncate text-foreground-subtle" title={current}>{current}</span>
          </span>
          <ChevronRightIcon className="size-3.5 shrink-0 group-open/background-tasks:rotate-90" aria-hidden="true" />
        </summary>
        <ul className="max-h-[min(16rem,30vh)] divide-y divide-border/60 overflow-y-auto overscroll-contain border-t border-border/60 px-3 text-ui-sm">
          {ordered.map(task => <BackgroundTaskItem key={task.id} task={task} rows={conversation.rows} sessionKey={conversation.sessionKey} canStop={conversation.agent === 'claude'} />)}
        </ul>
      </details>
    </section>
  );
}
