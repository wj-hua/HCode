// 明确分离只读规划、保存范围、用户确认与建副本；执行和采纳结果由既有 Run 视图展示。
import { LoaderCircleIcon } from 'lucide-react';
import type { Conversation } from '../store/appStore';
import type { CodeDraftInput } from '@hcode/shared/codeDraft';
import { COLLABORATION_LIMITS } from '@hcode/shared/collaboration';
import type { CollaborationSnapshot, CollaborationCapabilities } from '@hcode/shared/collaboration';
import { Button } from '@/components/ui/button.js';
import { useCodeDraft } from './useCodeDraft';
import { CodeDraftTasks } from './CodeDraftTasks';
import { CodeDraftScope } from './CodeDraftScope';
import { CodeDraftReview } from './CodeDraftReview';
import { codePlanIssues } from './codeDraftPresentation';
const EDITOR_ROWS = 3;
const FEEDBACK = 'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:brightness-90';
export function CodeDraftPanel({ conversation, input, capabilities, unavailable, onStarted }: { conversation: Conversation; input: Omit<CodeDraftInput, 'initiator'>; capabilities: CollaborationCapabilities[]; unavailable?: string; onStarted(run: CollaborationSnapshot, input: string): void }) {
  const plan = useCodeDraft(conversation, input, onStarted), draft = plan.draft, edit = plan.edit;
  const preparing = draft?.status === 'preparing', terminal = draft?.status === 'started' || draft?.status === 'abandoned', locked = plan.busy || preparing || draft?.status === 'starting';
  const issues = draft && edit ? codePlanIssues(draft, edit, capabilities, plan.changed, unavailable) : [];
  const configurationIssues = draft && edit ? codePlanIssues(draft, { ...edit, acceptWorkspace: true }, capabilities, false, unavailable) : [];
  return <section aria-label="代码交付计划" className="flex flex-col gap-3">
    <p className="font-medium">先核对代码计划，再创建隔离副本</p>
    <p className="text-ui-sm text-foreground-subtle">当前 AI 只读项目资料后建议任务和准确文件范围。生成计划使用额度，不写文件、不执行检查、不创建副本。</p>
    {plan.loading ? <p role="status">正在读取代码计划…</p> : null}
    {plan.error || draft?.error ? <p role={draft?.status === 'cancelled' && !plan.error ? 'status' : 'alert'} className="whitespace-pre-wrap text-destructive">{plan.error || draft?.error}</p> : null}
    {unavailable && !draft ? <p role="status">{unavailable}</p> : null}
    {preparing ? <div role="status" className="flex flex-wrap items-center justify-between gap-2"><span className="flex items-center gap-2"><LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" />正在制定代码计划，尚未创建副本</span><Button type="button" variant="outline" onClick={() => void plan.cancel()}>取消规划</Button></div> : <Button type="button" variant={draft && !terminal ? 'outline' : 'default'} className={FEEDBACK} disabled={plan.loading || locked || Boolean(unavailable) || !(input.objective.trim() || edit?.objective.trim())} onClick={() => void plan.generate()}>{draft && !terminal ? '重新生成代码计划' : '生成代码计划并查看范围'}</Button>}
    {draft && edit && !terminal ? <>
      <div className="flex items-center justify-between text-ui-sm"><span>{draft.confidence === 'needsInput' && !edit.tasks.length ? '资料不足，请补目标或手动填写任务' : draft.status === 'ready' ? '计划待确认' : '计划尚未就绪'}</span><span>版本 {draft.revision}</span></div>
      {draft.summary ? <p className="whitespace-pre-wrap">{draft.summary}</p> : null}
      <label className="flex flex-col gap-1">代码交付目标<textarea aria-label="代码计划交付目标" rows={EDITOR_ROWS} maxLength={COLLABORATION_LIMITS.maxContextLength} value={edit.objective} disabled={locked} onChange={event => plan.update({ ...edit, objective: event.target.value })} className="rounded-md border border-border bg-background p-2 focus-visible:ring-2 focus-visible:ring-ring" /></label>
      <CodeDraftTasks draft={draft} edit={edit} capabilities={capabilities} disabled={locked} onChange={plan.update} />
      <CodeDraftReview edit={edit} capabilities={capabilities} disabled={locked} onChange={plan.update} />
      <CodeDraftScope draft={draft} edit={edit} disabled={locked} onChange={plan.update} />
      <label className="flex items-start gap-2 text-ui-sm"><input aria-label="确认代码计划范围与检查" type="checkbox" checked={edit.acceptWorkspace} disabled={locked || plan.changed || configurationIssues.length > 0 || !['ready', 'editing'].includes(draft.status)} onChange={event => void plan.acknowledge(event.target.checked)} />我已核对准确文件范围、完整复制清单和勾选的检查，确认开始隔离交付。通过后逐项预览采纳，不自动写回。</label>
      {issues.length ? <div role="status" className="text-ui-sm"><p className="font-medium">开始前还需：</p><ul className="mt-1 list-disc space-y-1 pl-5">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div> : null}
      <div className="flex flex-wrap gap-2">{plan.changed ? <Button type="button" className={FEEDBACK} variant="outline" disabled={locked || Boolean(unavailable)} onClick={() => void plan.save()}>保存代码计划</Button> : null}<Button type="button" className={FEEDBACK} disabled={plan.busy || preparing || !['ready', 'starting'].includes(draft.status) || issues.length > 0} onClick={() => void plan.confirm()}>{draft.status === 'starting' ? '找回本次确认结果' : '确认范围并开始代码协作'}</Button><Button type="button" variant="ghost" className={FEEDBACK} disabled={locked} onClick={() => void plan.abandon()}>放弃代码计划</Button></div>
      <details><summary className="cursor-pointer text-ui-sm">规划资料和原生记录</summary>{draft.sources.map(file => <p key={file.path} className="mt-1 break-all text-ui-sm">{file.path} · {file.hash}</p>)}{draft.turns.map(turn => <p key={turn.id} className="mt-2 whitespace-pre-wrap text-ui-sm">{turn.agent} · {turn.status}{turn.error ? ` · ${turn.error}` : ''}</p>)}</details>
    </> : null}
  </section>;
}
