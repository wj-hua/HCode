// 只接受窄任务、准确文件和宿主检查 ID；模型不能提交 shell 或扩展执行权限。
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AGENT_KINDS } from '../../../shared/agents.js';
import type { CodeDraft } from '../../../shared/codeDraft.js';
import { CODE_DRAFT_LIMITS } from '../../../shared/codeDraft.js';
import { CODE_WORKSPACE_LIMITS } from '../../../shared/codeDelivery.js';
import { backendSchema, startSchema } from '../collaborationSchemas.js';
import { writeTaskSchema, checkIdSchema, admissionSchema } from '../workspaces/codeContracts.js';
import { draftSchema } from './draftContracts.js';
export const codePlannedTaskSchema = writeTaskSchema.extend({ name: z.string().trim().min(1).max(CODE_DRAFT_LIMITS.maxNameLength), reason: z.string().trim().min(1).max(CODE_DRAFT_LIMITS.maxReasonLength), dependsOn: z.array(z.string()).max(CODE_DRAFT_LIMITS.maxTasks) });
const taskList = z.array(codePlannedTaskSchema).max(CODE_DRAFT_LIMITS.maxTasks).refine(tasks => new Set(tasks.map(task => task.requestKey)).size === tasks.length, '任务键重复');
export const codeDraftInputSchema = z.object({ initiator: startSchema.shape.initiator, objective: startSchema.shape.objective, backendPreferences: z.array(writeTaskSchema.shape.executor).min(1).max(CODE_DRAFT_LIMITS.maxTasks), reviewer: backendSchema.optional() }).strict();
const paramsSchema = codeDraftInputSchema.extend({ tasks: taskList, checks: z.array(checkIdSchema).max(CODE_DRAFT_LIMITS.maxChecks).refine(checks => new Set(checks).size === checks.length, '检查重复'), acceptWorkspace: z.boolean() });
export const codeDraftEditSchema = paramsSchema.pick({ objective: true, tasks: true, reviewer: true, checks: true, acceptWorkspace: true });
export const codeProposalSchema = z.object({ confidence: z.enum(['ready', 'needsInput']), summary: z.string().trim().min(1).max(CODE_DRAFT_LIMITS.maxReasonLength), sources: z.array(z.string().min(1)).max(20), tasks: z.array(codePlannedTaskSchema.omit({ executor: true })).max(CODE_DRAFT_LIMITS.maxTasks) }).strict().superRefine((value, context) => {
  if (value.confidence === 'ready' && !value.tasks.length || value.confidence === 'needsInput' && value.tasks.length || new Set(value.tasks.map(task => task.requestKey)).size !== value.tasks.length) context.addIssue({ code: 'custom', message: '有效计划须有一或两项任务；信息不足时任务保持为空' });
});
export const codeDraftSchema = draftSchema.extend({ params: paramsSchema, confidence: codeProposalSchema.shape.confidence.optional(), admission: admissionSchema.optional(), copyPaths: z.array(z.string().min(1)).max(CODE_WORKSPACE_LIMITS.maxFiles), capabilities: z.array(z.object({ agent: z.enum(AGENT_KINDS), version: z.string().optional(), canInitiate: z.boolean(), canExecute: z.boolean(), canReview: z.boolean(), canExecuteCode: z.boolean(), models: z.array(z.string()) }).strict()).max(5) });
/** 确認同時綁定任务、检查命令、复制清单、原会话和累计规划回合。 */
export function codeDraftHash(draft: CodeDraft) {
  return createHash('sha256').update(JSON.stringify({ revision: draft.revision, params: draft.params, sources: draft.sources, turns: draft.turns, admission: draft.admission, copyPaths: draft.copyPaths, capabilities: draft.capabilities, confidence: draft.confidence })).digest('hex');
}
