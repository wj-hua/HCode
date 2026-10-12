// 运行时校验模型结果与 IPC 输入；格式无效/证据不足不能转换成默认成功。
import { COLLABORATION_LIMITS, COLLABORATION_WORKER_AGENTS } from "../../shared/collaboration.js";
import { codeStateSchema } from "./workspaces/codeContracts.js";
import { expertStartSchema, expertStateSchema } from './experts/expertContracts.js';
import { z } from "zod";

export const MAX_REPORT_BYTES = 64 * 1024;
export const MAX_REVISIONS = COLLABORATION_LIMITS.maxRevisions;
export const MAX_RUN_TURNS = COLLABORATION_LIMITS.maxTurns;
export const MAX_DELIVERIES = COLLABORATION_LIMITS.maxDeliveries;
export const MAX_CONCURRENT_WORKERS = COLLABORATION_LIMITS.maxConcurrentWorkers;
export const WAIT_TOOL_MS = 30_000;
export const RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const TURN_TIMEOUT_MS = 10 * 60 * 1000;

export { startSchema, reportSchema, reviewSchema } from "./collaborationSchemas.js";
import { startSchema, reportSchema, reviewSchema, versionSchema } from "./collaborationSchemas.js";
export const snapshotSchema = z.object({
  id: z.string().uuid(), seq: z.number().int().nonnegative(), createdAt: z.number(), params: z.union([startSchema,expertStartSchema]),
  status: z.enum(["running", "stopping", "paused", "awaitingUser", "completed", "failed", "cancelled", "interrupted"]),
  stage: z.enum(["planning", "awaitingWorkers", "expertResearch", "peerReview", "synthesis", "finished"]),
  tasks: z.array(z.object({ id: z.string().uuid(), deliveryId: z.string().uuid().optional(), expertId:z.string().uuid().optional(), sessionKey: z.string().uuid(), agent: z.enum(COLLABORATION_WORKER_AGENTS), model: z.string().optional(), role: z.enum(["planning", "execution", "review", "synthesis"]), status: z.enum(["running", "succeeded", "failed", "cancelled", "interrupted"]), nativeSessionId: z.string().optional(), error: z.string().optional(), usage: z.object({ contextUsedTokens: z.number().optional(), contextWindowTokens: z.number().optional(), contextUsedPercent: z.number().optional(), inputTokens: z.number().optional(), outputTokens: z.number().optional() }).strict().optional() }).strict()),
  deliveries: z.array(z.object({ code: codeStateSchema.optional(), id: z.string().uuid(), requestKey: z.string(), objective: z.string(), executor: startSchema.shape.executor, status: z.enum(["queued", "executing", "reviewing", "revising", "accepted", "failed", "awaitingUser", "cancelled", "interrupted"]), versions: z.array(versionSchema), reviews: z.array(z.object({ versionId: z.string().uuid(), verdict: z.enum(["approved", "changesRequested", "inconclusive"]), summary: z.string(), issues: reviewSchema.shape.issues, reviewer: z.object({ agent: z.enum(["claude", "codex", "agy", "cline"]), sessionKey: z.string().uuid(), nativeSessionId: z.string().optional() }).strict().optional() }).strict()), error: z.string().optional(), workerSessionKey: z.string().uuid().optional() }).strict()),
  summary: z.string().optional(), error: z.string().optional(), persistenceError: z.string().optional(),
  stopIntent: z.enum(["pause", "cancel"]).optional(),
  code: codeStateSchema.optional(),
  experts:expertStateSchema.optional(),
  messages: z.array(z.object({ id: z.string().uuid(), deliveryId: z.string().uuid(), requestKey: z.string(), sender: z.enum(["worker", "initiator", "user"]), recipient: z.enum(["initiator", "worker"]), type: z.enum(["clarification", "answer", "context"]), text: z.string().max(COLLABORATION_LIMITS.maxContextLength), createdAt: z.number(), requiresUser: z.boolean().optional(), replyTo: z.string().uuid().optional() }).strict()).max(COLLABORATION_LIMITS.maxMessages).optional(),
}).strict().superRefine((snapshot,context)=>{
  if((snapshot.params.mode==='experts')!==Boolean(snapshot.experts)||snapshot.experts&&(snapshot.code||snapshot.deliveries.length))context.addIssue({code:'custom',message:'专家状态与协作模式不一致'});
  if(snapshot.params.mode!=='experts'){
    const options=snapshot.params.code,configured=options?.tasks;
    if(configured){
      const mismatch=snapshot.code || snapshot.deliveries.length!==configured.length || new Set(snapshot.deliveries.map(delivery=>delivery.code?.workspace.id)).size!==configured.length || snapshot.deliveries.some(delivery=>{
        const task=configured.find(task=>task.requestKey===delivery.requestKey),code=delivery.code;
        return !task||!code||task.objective!==delivery.objective||task.executor.agent!==delivery.executor.agent||task.executor.model!==delivery.executor.model||JSON.stringify(task.allowedPaths)!==JSON.stringify(code.allowedPaths)||code.workspace.runId!==snapshot.id||code.workspace.originalPath!==snapshot.params.initiator.projectPath||code.workspace.baselineHash!==options!.admissionHash;
      });
      if(mismatch)context.addIssue({code:'custom',message:'并行写任务状态与用户确认计划或共同基线不一致'});
    }else if(snapshot.deliveries.some(delivery=>delivery.code))context.addIssue({code:'custom',message:'未配置并行写任务，不能附加独立代码工作区'});
  }
  if(snapshot.params.mode==='experts'&&snapshot.experts&&(snapshot.experts.turnLimit??MAX_RUN_TURNS)!==(snapshot.params.turnLimit??MAX_RUN_TURNS))context.addIssue({code:'custom',message:'专家累计预算与启动配置不一致'});
});

/** 仅接受完整 JSON 或完整 JSON fence，不从自由文本猜测某个片段。 */
export function parseModelJson(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_REPORT_BYTES) throw new Error("模型报告超过大小限制");
  const fence = /^\s*```(?:json)?\s*\n([\s\S]*)\n```\s*$/.exec(text);
  return JSON.parse(fence ? fence[1]! : text);
}

export function reportMarkdown(report: z.infer<typeof reportSchema>) {
  return [report.summary, ...report.findings.map((finding) => `### ${finding.id} · ${finding.title}\n\n${finding.detail}\n\n${finding.evidence.map((entry) => `- ${entry.path}:${entry.startLine}–${entry.endLine}\n\n> ${entry.quote.replace(/\n/g, "\n> ")}`).join("\n")}`), ...(report.limitations.length ? ["### 局限\n\n" + report.limitations.map((limit) => `- ${limit}`).join("\n")] : [])].join("\n\n");
}

export const resumeSchema = z.object({ deliveryId: z.string().uuid().optional(), action: z.enum(["execute", "review"]), context: z.string().trim().min(1).max(COLLABORATION_LIMITS.maxContextLength).optional() }).strict();
