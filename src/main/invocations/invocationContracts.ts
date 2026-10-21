// 参数校验和跨 CLI 权限映射；只读由运行时执行，主 AI 不能借子会话提权。
import { z } from 'zod';
import { INVOCATION_AGENTS, INVOCATION_LIMITS } from '../../shared/agentInvocation.js';
import type { AgentInvocationInput } from '../../shared/agentInvocation.js';
import type { ChatSendParams } from '../../shared/types.js';
import { adoptionPath } from '../collaboration/adoption/adoptionContracts.js';
export const invocationInputSchema = z.object({
  agent: z.enum(INVOCATION_AGENTS), prompt: z.string().min(1).max(INVOCATION_LIMITS.maxPromptLength).refine(value => Boolean(value.trim()), '提示词不能为空'),
  mode: z.enum(['read-only', 'execute']), model: z.string().min(1).optional(), continueInvocationId: z.string().uuid().optional(),
}).strict();
export const invocationWriteScopeSchema = z.object({ batchId: z.string().uuid(), taskKey: z.string().trim().min(1).max(120),
  allowedPaths: z.array(adoptionPath.refine(path => !/[\*?\[\]]/.test(path), '文件范围不支持通配符')).min(1).max(INVOCATION_LIMITS.maxWritePaths),
}).strict();
export const parallelInvocationSchema = z.object({ tasks: z.array(z.object({
  taskKey: invocationWriteScopeSchema.shape.taskKey, agent: z.enum(INVOCATION_AGENTS), prompt: invocationInputSchema.shape.prompt,
  model: invocationInputSchema.shape.model, allowedPaths: invocationWriteScopeSchema.shape.allowedPaths,
}).strict()).min(1).max(INVOCATION_LIMITS.maxParallelTasks).refine(tasks => new Set(tasks.map(task => task.taskKey)).size === tasks.length, '任务键重复') }).strict();
const sourceSchema = z.object({ agent: z.enum(['claude', 'codex', 'agy']), sessionKey: z.string(), projectPath: z.string(), permissionMode: z.string(), resumeSessionId: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), codexSpeed: z.string().optional() });
export const invocationSchema = z.object({
  id: z.string().uuid(), seq: z.number().int().positive(), createdAt: z.number(), source: sourceSchema, sourceTurnId: z.string(), input: invocationInputSchema,
  sessionKey: z.string().uuid(), nativeSessionId: z.string().optional(), status: z.enum(['running', 'stopping', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  output: z.string().optional(), error: z.string().optional(), usage: z.record(z.string(), z.unknown()).optional(),
  writeScope: invocationWriteScopeSchema.optional(),
  writeFeedback: z.array(z.object({ code: z.string(), path: z.string(), error: z.string(), guidance: z.string() }).strict()).optional(),
});
/** 完全放行仅继承当前会话已经选择的完全放行；其他执行使用目标 CLI 自己的审批。 */
export function invocationPermission(source: ChatSendParams, input: AgentInvocationInput) {
  if (input.mode === 'read-only') return input.agent === 'codex' ? 'read-only' : 'default';
  if (source.permissionMode === 'plan' || source.permissionMode === 'read-only') throw new Error('当前会话处于只读或计划模式，不能委派代码执行');
  const unrestricted = source.agent === 'claude' && source.permissionMode === 'bypassPermissions' || source.agent === 'codex' && source.permissionMode === 'full-access';
  if (unrestricted) return { claude: 'bypassPermissions', codex: 'full-access', agy: 'bypass' }[input.agent];
  return { claude: 'default', codex: 'on-request', agy: 'default' }[input.agent];
}
