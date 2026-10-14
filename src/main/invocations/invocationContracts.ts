// 参数校验和跨 CLI 权限映射；只读由运行时执行，主 AI 不能借子会话提权。
import { z } from 'zod';
import { INVOCATION_LIMITS } from '../../shared/agentInvocation.js';
import type { AgentInvocationInput } from '../../shared/agentInvocation.js';
import type { ChatSendParams } from '../../shared/types.js';
export const invocationInputSchema = z.object({
  agent: z.enum(['claude', 'codex']), prompt: z.string().min(1).max(INVOCATION_LIMITS.maxPromptLength).refine(value => Boolean(value.trim()), '提示词不能为空'),
  mode: z.enum(['read-only', 'execute']), model: z.string().min(1).optional(), continueInvocationId: z.string().uuid().optional(),
}).strict();
const sourceSchema = z.object({ agent: z.enum(['claude', 'codex', 'agy']), sessionKey: z.string(), projectPath: z.string(), permissionMode: z.string(), resumeSessionId: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), codexSpeed: z.string().optional() });
export const invocationSchema = z.object({
  id: z.string().uuid(), seq: z.number().int().positive(), createdAt: z.number(), source: sourceSchema, sourceTurnId: z.string(), input: invocationInputSchema,
  sessionKey: z.string().uuid(), nativeSessionId: z.string().optional(), status: z.enum(['running', 'stopping', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  output: z.string().optional(), error: z.string().optional(), usage: z.record(z.string(), z.unknown()).optional(),
});
/** 完全放行仅继承当前会话已经选择的完全放行；其他执行使用目标 CLI 自己的审批。 */
export function invocationPermission(source: ChatSendParams, input: AgentInvocationInput) {
  if (input.mode === 'read-only') return input.agent === 'claude' ? 'default' : 'read-only';
  if (source.permissionMode === 'plan' || source.permissionMode === 'read-only') throw new Error('当前会话处于只读或计划模式，不能委派代码执行');
  const unrestricted = source.agent === 'claude' && source.permissionMode === 'bypassPermissions' || source.agent === 'codex' && source.permissionMode === 'full-access';
  if (unrestricted) return input.agent === 'claude' ? 'bypassPermissions' : 'full-access';
  return input.agent === 'claude' ? 'default' : 'on-request';
}
