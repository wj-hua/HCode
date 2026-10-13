// 主会话持续展示宿主目标和真实阶段；详情沿用同一会话的协作侧栏。
import type { CollaborationPresentation, PresentationTask } from '@hcode/shared/collaborationPresentation';
import { TASK_RESULT_LABELS, presentationContent, collaborationInputTitle } from '@hcode/shared/collaborationPresentation';
import { LoaderIcon, CheckIcon, CircleIcon } from 'lucide-react';
import { AGENTS } from '@hcode/shared/agents';
import { Button } from '@/components/ui/button.js';
import { useUiStore } from '../store/uiStore';

export function CollaborationProgress({ entry, viewId, task }: { entry: CollaborationPresentation; viewId?: string; task?: PresentationTask }) {
  const setSidePanel = useUiStore(state => state.setSidePanel);
  const content = presentationContent(entry, task);
  return <section className="rounded-lg border border-border bg-surface p-3" aria-label="协作进度">
    <p className="line-clamp-3 font-medium">{task?.role === 'planning' && entry.experts ? entry.objective : task ? task.label : collaborationInputTitle(entry.objective)}</p>
    <p role="status" className="mt-1 flex items-center gap-2 text-ui-sm text-foreground-subtle">{!task && entry.experts?.busy ? <LoaderIcon aria-hidden className="size-3.5 animate-spin" /> : null}{task ? TASK_RESULT_LABELS[task.status] : `${entry.status}${entry.stage ? ` · ${entry.stage}` : ""}`}</p>
    {task ? <p className="mt-1 text-ui-sm text-foreground-subtlest">{AGENTS[task.agent].name}{task.model ? ` · ${task.model}` : ''}</p> : null}
    {content.summary && !entry.experts ? <div className="mt-2"><p className="text-ui-sm text-foreground-subtle">{content.summaryLabel}</p><p className="line-clamp-3 whitespace-pre-wrap">{content.summary}</p></div> : null}
    {!task && entry.experts ? <div className="mt-3 space-y-2">
      <p className="text-ui-sm text-foreground-subtle">研究报告 {entry.experts.research.completed} / {entry.experts.research.total}{entry.experts.phase !== 'expertResearch' && entry.experts.review.total ? ` · 互审 ${entry.experts.review.completed} / ${entry.experts.review.total}` : ''}</p>
      <ul className="space-y-2">{entry.experts.participants.map(expert => <li key={expert.id} className="flex items-start gap-2">
        {expert.busy ? <LoaderIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin" /> : expert.complete ? <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" /> : <CircleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-foreground-subtle" />}
        <div className="min-w-0 flex-1"><div className="flex flex-wrap justify-between gap-x-3"><span>{expert.label}</span><span className="text-ui-sm text-foreground-subtle">{expert.state}</span></div>{expert.error ? <p className="text-ui-sm text-destructive">{expert.error}</p> : null}</div>
      </li>)}</ul>
    </div> : null}
    {content.error ? <p role="alert" className="mt-2 whitespace-pre-wrap text-destructive">{content.error}</p> : null}
    {viewId ? <Button variant="outline" className="mt-3" onClick={() => setSidePanel({ type: 'collaboration', viewId, intent: 'records', runId: entry.runId })}>查看任务与结果</Button> : null}
  </section>;
}
