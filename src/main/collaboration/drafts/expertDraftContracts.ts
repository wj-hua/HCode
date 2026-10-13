// 专家草案只接受七类业务角色；模型不能指定执行后端或授予能力。
import { createHash } from "node:crypto";
import { z } from "zod";
import { BUSINESS_EXPERT_TYPES } from "../../../shared/expertProfiles.js";
import { EXPERT_LIMITS, expertMinimumTurns } from "../../../shared/experts.js";
import type { ExpertDraft } from "../../../shared/expertDraft.js";
import { backendSchema, startSchema } from "../collaborationSchemas.js";
import { profileSnapshotSchema } from "../experts/profiles/profileContracts.js";
import { snapshotSchema } from "../contracts.js";
import { draftSchema } from "./draftContracts.js";
export const expertAssignmentSchema = z.object({ role: z.enum(BUSINESS_EXPERT_TYPES), objective: startSchema.shape.objective, reason: z.string().trim().min(1).max(2000), backend: backendSchema, profileHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const assignmentsSchema = z.array(expertAssignmentSchema).max(EXPERT_LIMITS.maxParticipants).refine(value => new Set(value.map(entry => entry.role)).size === value.length, "专家角色不能重复");
const budgetSchema = z.number().int().min(expertMinimumTurns(EXPERT_LIMITS.minParticipants)).max(EXPERT_LIMITS.maxTurns);
export const expertDraftInputSchema = z.object({ initiator: startSchema.shape.initiator, objective: startSchema.shape.objective, backendPreferences: z.array(backendSchema).min(1).max(3), turnLimit: budgetSchema }).strict();
const paramsSchema = expertDraftInputSchema.extend({ experts: assignmentsSchema, acceptProfileLimitations: z.boolean() });
export const expertDraftEditSchema = paramsSchema.pick({ objective: true, experts: true, turnLimit: true, acceptProfileLimitations: true }).superRefine((value, context) => {
  if (value.turnLimit < expertMinimumTurns(value.experts.length)) context.addIssue({ code: "custom", message: "专家预算不足以完成独立研究、互审和汇总" });
});
export const expertProposalSchema = z.object({
  confidence: z.enum(["identified", "needsSelection"]), summary: z.string().trim().min(1).max(2000), sources: z.array(z.string().min(1)).max(20),
  experts: z.array(expertAssignmentSchema.omit({ backend: true, profileHash: true })).max(EXPERT_LIMITS.maxParticipants),
}).strict().superRefine((value, context) => {
  if (value.confidence === "identified" && value.experts.length < EXPERT_LIMITS.minParticipants || value.confidence === "needsSelection" && value.experts.length !== 0 || new Set(value.experts.map(entry => entry.role)).size !== value.experts.length) context.addIssue({ code: "custom", message: "推荐团队的数量或角色无效；未知项目必须由用户选择" });
});
export const expertDraftSchema = draftSchema.extend({
  params: paramsSchema,
  turns: snapshotSchema.shape.tasks.max(EXPERT_LIMITS.maxTurns),
  confidence: expertProposalSchema.shape.confidence.optional(),
  profiles: z.array(profileSnapshotSchema.extend({ issues: z.array(z.string()) })).max(EXPERT_LIMITS.maxParticipants),
  capabilities: z.array(z.object({ agent: z.string(), version: z.string().optional(), canInitiate: z.boolean(), canExecute: z.boolean(), canReview: z.boolean(), models: z.array(z.string()) }).strict()).max(5),
});
/** 确认绑定本次预览的组合及后端能力；状态、错误和 Run 引用不参与内容摘要。 */
export function expertDraftHash(draft: ExpertDraft) {
  return createHash("sha256").update(JSON.stringify({ revision: draft.revision, params: draft.params, sources: draft.sources, turns: draft.turns, profiles: draft.profiles, capabilities: draft.capabilities, confidence: draft.confidence })).digest("hex");
}
