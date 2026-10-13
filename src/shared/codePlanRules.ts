// 代码计划的纯业务规则，由主进程最终准入和界面缺口说明共用；实际文件类型仍需宿主核对。
import type { CodeDraft, CodeDraftEdit } from './codeDraft.js';
import { CODE_DRAFT_LIMITS, codeDraftRemainingTurns } from './codeDraft.js';
import { COLLABORATION_LIMITS } from './collaboration.js';
import type { PlanningCapability } from './planningDraft.js';
import { ADOPTION_LOCK_DIRECTORY } from './codeAdoption.js';
const RESERVED_PARTS = ['.git', 'node_modules', ADOPTION_LOCK_DIRECTORY];
export function codeTaskPathIssue(path: string): string | undefined {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..' || RESERVED_PARTS.includes(part))) return `文件路径不属于允许范围：${path || '空路径'}`;
  if (/[\*?\[\]]/.test(path)) return `文件清单不支持目录或通配符：${path}`;
}
export function codeDraftIssues(draft: CodeDraft, edit: CodeDraftEdit, capabilities: PlanningCapability[], confirming: boolean): string[] {
  const issues: string[] = [];
  if (!edit.objective.trim()) issues.push('请填写代码交付目标。');
  if (!draft.admission) issues.push('缺少实际项目复制与验证清单，请重新生成计划。');
  if (edit.tasks.length < CODE_DRAFT_LIMITS.minTasks || edit.tasks.length > CODE_DRAFT_LIMITS.maxTasks) issues.push('请提供一或两项独立代码任务。');
  const paths: string[] = [];
  for (const task of edit.tasks) {
    if (!task.name.trim() || !task.objective.trim() || !task.allowedPaths.length) issues.push(`${task.name || '任务'}缺少名称、目标或准确文件范围。`);
    if (task.dependsOn.length) issues.push(`${task.name}存在任务依赖，请合成一项完整任务。`);
    if (!capabilities.find(value => value.agent === task.executor.agent)?.canExecuteCode) issues.push(`${task.name}的执行 AI 未通过代码写入准入。`);
    for (const path of task.allowedPaths) {
      const issue = codeTaskPathIssue(path), normalized = path.toLowerCase();
      if (issue) issues.push(issue);
      if (paths.some(previous => previous === normalized || previous.startsWith(`${normalized}/`) || normalized.startsWith(`${previous}/`))) issues.push(`写入范围重复或重叠：${path}；请合并任务或调整分工。`);
      paths.push(normalized);
    }
  }
  if (!edit.checks.length || edit.checks.some(id => !draft.admission?.checks.some(check => check.id === id))) issues.push('请选择本次项目发现的必需检查，不能提交任意命令。');
  if (draft.turns.length + codeDraftRemainingTurns(edit.tasks.length) > COLLABORATION_LIMITS.maxTurns) issues.push('剩余预算不足以执行、独立审查和汇总。');
  const reviewer = edit.reviewer ?? draft.params.initiator, capability = capabilities.find(value => value.agent === reviewer.agent);
  if (!capability?.canReview) issues.push('独立审查 AI 未通过准入。');
  if (reviewer.agent === 'agy' && (!reviewer.model || !capability?.models.includes(reviewer.model))) issues.push('请选择账号可用的 Gemini 审查模型。');
  if (confirming && !edit.acceptWorkspace) issues.push('请先核对并确认文件范围、复制清单和检查计划。');
  return [...new Set(issues)];
}
