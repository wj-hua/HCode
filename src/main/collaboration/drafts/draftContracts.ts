// 草案 IPC、模型提案及落盘记录的校验；不推测自由文本中的计划。
import { z } from "zod";
import { createHash } from "node:crypto";
import { startSchema } from "../collaborationSchemas.js";
import { snapshotSchema } from "../contracts.js";
import { COLLABORATION_LIMITS } from "../../../shared/collaboration.js";
import type { PlanningDraft } from "../../../shared/planningDraft.js";

export const draftInputSchema = startSchema.omit({ mode: true, code: true });
export const draftEditSchema = draftInputSchema.pick({ objective: true, executor: true, reviewer: true });
export const proposalSchema = z.object({
  taskObjective: startSchema.shape.objective,
  summary: z.string().trim().min(1).max(2000),
  sources: z.array(z.string().min(1)).max(20),
}).strict();
export const draftSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().positive(), createdAt: z.number(),
  status: z.enum(["editing", "preparing", "ready", "blocked", "cancelled", "abandoned", "starting", "started"]),
  params: draftInputSchema, summary: z.string().optional(),
  sources: z.array(z.object({ path: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  turns: snapshotSchema.shape.tasks.max(COLLABORATION_LIMITS.maxTurns),
  error: z.string().optional(), rawResult: z.string().optional(),
  approvalHash: z.string().optional(), runId: z.string().uuid().optional(),
}).strict();
/** 绑定确认时的目标、原会话、AI 配置、读取版本及已消耗回合。 */
export function draftHash(draft: PlanningDraft) {
  return createHash("sha256").update(JSON.stringify({ revision: draft.revision, params: draft.params, sources: draft.sources, turns: draft.turns })).digest("hex");
}
export function assertRevision(draft: PlanningDraft, revision: number) {
  if (draft.revision !== z.number().int().positive().parse(revision)) throw new Error("计划版本已变化，请重新查看并确认");
}
export function assertEditable(draft: PlanningDraft) {
  if (!["editing", "ready", "blocked", "cancelled"].includes(draft.status)) throw new Error("当前计划不能修改或重新生成");
}
