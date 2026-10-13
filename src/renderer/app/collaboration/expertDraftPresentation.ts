// 界面显示所有缺少条件；最终准入仍由主进程核对当前版本和真实能力。
import type { ExpertDraft, ExpertDraftEdit } from "@hcode/shared/expertDraft";
import type { CollaborationCapabilities } from "@hcode/shared/collaboration";
import { EXPERT_ROLES, EXPERT_LIMITS } from "@hcode/shared/experts";
export function expertPlanIssues(draft: ExpertDraft, edit: ExpertDraftEdit, capabilities: CollaborationCapabilities[], changed: boolean, unavailable?: string) {
  const issues: string[] = [];
  if (unavailable) issues.push(unavailable);
  if (!edit.objective.trim()) issues.push("请填写评审目标。");
  if (edit.experts.length < EXPERT_LIMITS.minParticipants || edit.experts.length > EXPERT_LIMITS.maxParticipants) issues.push("请选择 2–7 位专家。");
  if (draft.turns.length + edit.experts.length * EXPERT_LIMITS.turnsPerParticipant + 1 > edit.turnLimit) issues.push("剩余预算不足以完成独立研究、互审和汇总，请减少团队或调整预算。");
  for (const expert of edit.experts) {
    const profile = draft.profiles.find(value => value.role === expert.role), capability = capabilities.find(value => value.agent === expert.backend.agent);
    if (!expert.objective.trim()) issues.push(`${EXPERT_ROLES[expert.role].name}缺少研究任务。`);
    if (!profile || profile.issues.length) issues.push(`${EXPERT_ROLES[expert.role].name}组合不可用：${profile?.issues.join("；") ?? "请重新生成计划"}`);
    if (!capability?.canExecute || !capability.canReview) issues.push(`${EXPERT_ROLES[expert.role].name}的 AI 尚未通过研究和互审检查。`);
    if (expert.backend.agent === "agy" && (!expert.backend.model || !capability?.models?.some(model => model.value === expert.backend.model))) issues.push(`${EXPERT_ROLES[expert.role].name}请选择账号可用的 Gemini 模型。`);
  }
  if (changed) issues.push("计划已修改，请先保存分工，再核对能力限制。");
  if (!edit.acceptProfileLimitations) issues.push("请查看并确认本次选定团队的能力限制。");
  return issues;
}
