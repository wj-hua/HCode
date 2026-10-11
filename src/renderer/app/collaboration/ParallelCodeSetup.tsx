// 两项用户确认的写任务配置；后端与文件范围在启动时冻结，模型不能扩展。
import { COLLABORATION_LIMITS } from '@hcode/shared/collaboration';
import type { CollaborationCapabilities } from '@hcode/shared/collaboration';
import type { CodeWriteTask } from '@hcode/shared/codeDelivery';
import { PARALLEL_CODE_LIMITS } from '@hcode/shared/codeDelivery';
import { AGENTS } from '@hcode/shared/agents';
const TASK_KEY_PREFIX='code-task-';
export const DEFAULT_WRITE_TASKS: CodeWriteTask[] = [
  {requestKey:`${TASK_KEY_PREFIX}1`,objective:'',executor:{agent:'claude'},allowedPaths:[]},
  {requestKey:`${TASK_KEY_PREFIX}2`,objective:'',executor:{agent:'codex'},allowedPaths:[]},
];
export function writeTasksReady(tasks: CodeWriteTask[], capabilities?: CollaborationCapabilities[]) {
  return tasks.length===PARALLEL_CODE_LIMITS.maxTasks && tasks.every(task=>task.objective.trim() && task.allowedPaths.length>0 && task.allowedPaths.length<=PARALLEL_CODE_LIMITS.maxPaths && task.allowedPaths.every(path=>path.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!['.git','node_modules','.hcode-apply-lock'].includes(part))&&!path.includes('\\')&&!path.includes('\0')&&!/[\*?\[\]]/.test(path)) && new Set(task.allowedPaths.map(path=>path.toLowerCase())).size===task.allowedPaths.length && capabilities?.find(entry=>entry.agent===task.executor.agent)?.canExecuteCode);
}
export function ParallelCodeSetup({enabled,onEnabled,tasks,onChange,capabilities}: {enabled:boolean;onEnabled:(value:boolean)=>void;tasks:CodeWriteTask[];onChange:(tasks:CodeWriteTask[])=>void;capabilities?:CollaborationCapabilities[]}) {
  const update=(index:number,patch:Partial<CodeWriteTask>)=>onChange(tasks.map((task,position)=>position===index?{...task,...patch}:task));
  return <section aria-label="并行写任务配置" className="flex flex-col gap-3">
    <label className="flex items-start gap-2"><input type="checkbox" checked={enabled} onChange={event=>onEnabled(event.target.checked)} />启用两个独立写任务并行协作</label>
    {enabled ? <><p className="text-ui-sm text-foreground-subtle">每项任务独立复制同一基线，互不读取对方副本。逐任务采纳，不自动合并；同名文件在原项目中变化后会阻止另一个候选采纳。两项共享 {COLLABORATION_LIMITS.maxTurns} 回合预算。检查针对各自基线执行，逐项采纳后请在原项目复测。</p>
      {tasks.map((task,index)=><fieldset key={task.requestKey} className="flex flex-col gap-2 rounded-lg border border-border p-3"><legend>写任务 {index+1} · {task.requestKey}</legend>
        <label className="flex items-center gap-3">执行者<select value={task.executor.agent} onChange={event=>update(index,{executor:{agent:event.target.value as 'claude'|'codex'}})} className="rounded-md border border-border bg-background p-1">{(['claude','codex'] as const).map(agent=><option key={agent} value={agent} disabled={!capabilities?.find(entry=>entry.agent===agent)?.canExecuteCode}>{AGENTS[agent].name}</option>)}</select></label>
        <label className="flex flex-col gap-1">任务目标<textarea required maxLength={COLLABORATION_LIMITS.maxContextLength} rows={2} value={task.objective} onChange={event=>update(index,{objective:event.target.value})} className="rounded-md border border-border bg-background p-2 focus-visible:ring-2 focus-visible:ring-ring" /></label>
        <label className="flex flex-col gap-1">允许修改的文件（相对项目路径，每行一个，包含需新增的测试）<textarea required rows={3} value={task.allowedPaths.join('\n')} onChange={event=>update(index,{allowedPaths:event.target.value.split('\n')})} placeholder={'src/example.ts\ntests/example.test.ts'} className="rounded-md border border-border bg-background p-2 focus-visible:ring-2 focus-visible:ring-ring" /></label>
      </fieldset>)}
      {!writeTasksReady(tasks,capabilities)?<p role="status">请填写两项任务目标和完整文件清单，并选择通过代码准入的执行者。禁止绝对路径、目录、通配符与大小写重复路径。</p>:null}
    </> : null}
  </section>;
}
