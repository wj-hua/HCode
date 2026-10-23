// 输入区上方的原生后台任务摘要与详情；生命周期由主进程提供，展开状态留在当前会话。
import { ChevronRightIcon, CircleCheckIcon, CircleHelpIcon, CircleStopIcon, CircleXIcon, LoaderIcon, TerminalIcon } from 'lucide-react';
import { BACKGROUND_TASK_STATUS_LABELS, type BackgroundTask } from '@hcode/shared/backgroundTasks';
import type { ConversationRow } from '@hcode/shared/types';
import { cn } from '@/components/lib/utils.js';
import type { Conversation } from '../store/appStore';

const STATUS_ICONS = {
  running: LoaderIcon, ended: CircleHelpIcon, completed: CircleCheckIcon,
  failed: CircleXIcon, stopped: CircleStopIcon, interrupted: CircleHelpIcon,
};

/** 只显示与原生 tool_use_id 精确匹配的命令，不扫描模型文字或其他任务输出。 */
function taskCommand(task: BackgroundTask, rows: readonly ConversationRow[]): string | undefined {
  if (!task.toolUseId) return undefined;
  const row = rows.find(item => item.kind === 'toolCall' && item.toolCallId === task.toolUseId);
  if (row?.kind !== 'toolCall' || !row.input || typeof row.input !== 'object' || !('command' in row.input)) return undefined;
  return typeof row.input.command === 'string' ? row.input.command : undefined;
}

function BackgroundTaskItem({ task, rows }: { task: BackgroundTask; rows: readonly ConversationRow[] }) {
  const Icon = STATUS_ICONS[task.status];
  const command = taskCommand(task, rows);
  return (
    <li className="space-y-1.5 py-2">
      <div className="flex items-start gap-2">
        <Icon aria-hidden="true" className={cn('mt-0.5 size-3.5 shrink-0', task.status === 'running' && 'animate-spin motion-reduce:animate-none', task.status === 'failed' && 'text-destructive', task.status === 'completed' && 'text-success')} />
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words font-medium">{task.description}</p>
          <p className="text-foreground-subtle">{BACKGROUND_TASK_STATUS_LABELS[task.status]}</p>
        </div>
      </div>
      {task.summary ? <p className="whitespace-pre-wrap break-words">{task.summary}</p> : null}
      {command ? <pre aria-label="执行命令" className="max-h-32 overflow-auto rounded-md bg-background p-2 font-mono text-ui-xs whitespace-pre-wrap break-all">{command}</pre> : null}
      {task.outputFile ? <p className="break-all text-foreground-subtle">输出文件：<span className="select-text font-mono">{task.outputFile}</span></p> : null}
    </li>
  );
}

export function BackgroundTaskPanel({ conversation }: { conversation: Pick<Conversation, 'viewId' | 'backgroundTaskDetails' | 'rows'> }) {
  const tasks = conversation.backgroundTaskDetails ?? [];
  if (!tasks.length) return null;
  const running = tasks.filter(task => task.status === 'running');
  const latest = running[0] ?? tasks.at(-1)!;
  const current = `${BACKGROUND_TASK_STATUS_LABELS[latest.status]} · ${latest.description}`;
  const ordered = [...running, ...tasks.filter(task => task.status !== 'running').reverse()];

  return (
    <section aria-label="后台任务" className="mb-2 rounded-xl border border-border/60 bg-surface">
      <details key={conversation.viewId} className="group/background-tasks">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-ui-sm outline-none hover:bg-surface-hover active:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <TerminalIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1" role="status" aria-live="polite" aria-atomic="true">
            <span className="block font-medium">后台任务 · {running.length} 项运行中</span>
            <span className="block truncate text-foreground-subtle" title={current}>{current}</span>
          </span>
          <ChevronRightIcon className="size-3.5 shrink-0 group-open/background-tasks:rotate-90" aria-hidden="true" />
        </summary>
        <ul className="max-h-[min(16rem,30vh)] divide-y divide-border/60 overflow-y-auto overscroll-contain border-t border-border/60 px-3 text-ui-sm">
          {ordered.map(task => <BackgroundTaskItem key={task.id} task={task} rows={conversation.rows} />)}
        </ul>
      </details>
    </section>
  );
}
