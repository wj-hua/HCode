// 单/双任务的分工与文件范围编辑；改动只发生在草案，不直接调用执行。
import type { CodeDraft, CodeDraftEdit, CodePlannedTask } from '@hcode/shared/codeDraft';
import { CODE_DRAFT_LIMITS } from '@hcode/shared/codeDraft';
import { COLLABORATION_LIMITS } from '@hcode/shared/collaboration';
import type { CollaborationCapabilities } from '@hcode/shared/collaboration';
import { Button } from '@/components/ui/button.js';
const EDITOR_ROWS = 3;
const INPUT_CLASS = 'min-w-0 rounded-md border border-border bg-background p-2 focus-visible:ring-2 focus-visible:ring-ring';
export function CodeDraftTasks({ draft, edit, capabilities, disabled, onChange }: { draft: CodeDraft; edit: CodeDraftEdit; capabilities: CollaborationCapabilities[]; disabled: boolean; onChange(value: CodeDraftEdit): void }) {
  const update = (key: string, value: Partial<CodePlannedTask>) => onChange({ ...edit, tasks: edit.tasks.map(task => task.requestKey === key ? { ...task, ...value } : task) });
  const preferred = draft.params.backendPreferences.find(backend => capabilities.find(value => value.agent === backend.agent)?.canExecuteCode);
  const add = () => { if (preferred) onChange({ ...edit, tasks: [...edit.tasks, { requestKey: crypto.randomUUID(), name: '新增独立任务', objective: '', allowedPaths: [], executor: preferred, dependsOn: [], reason: '用户新增，请填写准确范围与验收要求。' }] }); };
  return <fieldset disabled={disabled} className="flex flex-col gap-3"><legend className="mb-2 font-medium">本次代码分工 · {edit.tasks.length} 项</legend>
    <p className="text-ui-sm text-foreground-subtle">每项在独立副本验证、审查和修订。两项不能依赖或修改同一文件，采纳后仍需组合复测。</p>
    {edit.tasks.map(task => <article key={task.requestKey} className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <label className="flex flex-col gap-1">任务名称<input aria-label="代码任务名称" value={task.name} maxLength={CODE_DRAFT_LIMITS.maxNameLength} className={INPUT_CLASS} onChange={event => update(task.requestKey, { name: event.target.value })} /></label>
      <p className="text-ui-sm text-foreground-subtle">分工依据：{task.reason}</p>
      <label className="flex flex-col gap-1">实现与验收任务<textarea aria-label={`${task.name}实现与验收任务`} value={task.objective} maxLength={COLLABORATION_LIMITS.maxContextLength} rows={EDITOR_ROWS} className={INPUT_CLASS} onChange={event => update(task.requestKey, { objective: event.target.value })} /></label>
      <label className="flex flex-col gap-1">允许修改文件（每行一个相对路径，包含新增测试）<textarea aria-label={`${task.name}允许修改文件`} rows={EDITOR_ROWS} value={task.allowedPaths.join('\n')} className={INPUT_CLASS} onChange={event => update(task.requestKey, { allowedPaths: event.target.value.split('\n') })} /></label>
      <label className="flex items-center gap-2">执行 AI<select value={task.executor.agent} className={INPUT_CLASS} onChange={event => { const agent = event.target.value as 'claude' | 'codex'; update(task.requestKey, { executor: draft.params.backendPreferences.find(value => value.agent === agent) ?? { agent } }); }}>{(['claude', 'codex'] as const).map(agent => <option key={agent} value={agent} disabled={!capabilities.find(value => value.agent === agent)?.canExecuteCode}>{agent === 'claude' ? 'Claude' : 'Codex'}</option>)}</select></label>
      <details><summary className="cursor-pointer text-ui-sm">模型设置</summary><label className="mt-2 flex flex-col gap-1">执行模型<input aria-label={`${task.name}执行模型`} value={task.executor.model ?? ''} placeholder="留空使用 CLI 默认模型" className={INPUT_CLASS} onChange={event => update(task.requestKey, { executor: { ...task.executor, model: event.target.value || undefined } })} /></label></details>
      {task.dependsOn.length ? <p role="alert">此任务存在依赖，不能开始。请合成完整单任务，或明确移除依赖并重新核对分工。<Button type="button" variant="outline" onClick={() => update(task.requestKey, { dependsOn: [] })}>移除本任务依赖</Button></p> : null}
      <Button type="button" variant="ghost" onClick={() => onChange({ ...edit, tasks: edit.tasks.filter(value => value.requestKey !== task.requestKey) })}>移除此任务</Button>
    </article>)}
    <Button type="button" variant="outline" disabled={!preferred || edit.tasks.length >= CODE_DRAFT_LIMITS.maxTasks} onClick={add}>添加独立任务（最多两项）</Button>
  </fieldset>;
}
