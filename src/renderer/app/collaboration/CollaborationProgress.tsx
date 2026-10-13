// 主会话持续展示宿主目标和真实阶段；详情沿用同一会话的协作侧栏。
import type { CollaborationPresentation, PresentationTask } from '@hcode/shared/collaborationPresentation';
import { TASK_RESULT_LABELS } from '@hcode/shared/collaborationPresentation';
import { AGENTS } from '@hcode/shared/agents';
import { Button } from '@/components/ui/button.js';
import { useUiStore } from '../store/uiStore';

export function CollaborationProgress({ entry, viewId, task }: { entry: CollaborationPresentation; viewId?: string; task?: PresentationTask }) {
  const setSidePanel = useUiStore(state => state.setSidePanel);
  return <section className="rounded-lg border border-border bg-surface p-3" aria-label="协作进度">
    <p className="line-clamp-3 font-medium">{task ? task.label : entry.objective}</p>
    <p role="status" className="mt-1 text-ui-sm text-foreground-subtle">{task ? TASK_RESULT_LABELS[task.status] : `${entry.status}${entry.stage ? ` · ${entry.stage}` : ""}`}</p>
    {task ? <p className="mt-1 text-ui-sm text-foreground-subtlest">{AGENTS[task.agent].name}{task.model ? ` · ${task.model}` : ''}</p> : null}
    {entry.summary && (!task || task.role === 'synthesis') ? <div className="mt-2"><p className="text-ui-sm text-foreground-subtle">{entry.summaryLabel}</p><p className="line-clamp-3 whitespace-pre-wrap">{entry.summary}</p></div> : null}
    {entry.error || task?.error ? <p role="alert" className="mt-2 whitespace-pre-wrap text-destructive">{task?.error ?? entry.error}</p> : null}
    {viewId ? <Button variant="outline" className="mt-3" onClick={() => setSidePanel({ type: 'collaboration', viewId, intent: 'records', runId: entry.runId })}>查看任务与结果</Button> : null}
  </section>;
}
