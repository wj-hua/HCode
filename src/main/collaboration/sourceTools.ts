// 原生线程的稳定工具契约；执行权限由绑定阶段的处理器决定，草案阶段明确拒绝调用。
import { z } from "zod";
import { COLLABORATION_LIMITS } from "../../shared/collaboration.js";
import type { HostedTool } from "../sessions/researchRuntime.js";
export function sourceTools(call: (name: string, input: Record<string, unknown>) => Promise<unknown>): HostedTool[] {
  const definitions: Omit<HostedTool, "execute">[] = [
    { name: "get_context_requests", description: "查询本次任务的待澄清问题；用户决定不能代批", schema: {} },
    { name: "reply_context", description: "在原权限范围内回复任务的已有上下文；需要用户决定的问题不能代答", schema: { messageId: z.string().uuid(), text: z.string().min(1).max(COLLABORATION_LIMITS.maxContextLength) } },
    { name: "delegate_task", description: "创建本次协作的只读子任务，自动送审及有界修订；返回 taskId", schema: { requestKey: z.string().min(1).max(120), objective: z.string().min(1).max(COLLABORATION_LIMITS.maxContextLength) } },
    { name: "get_task_result", description: "查询本次任务的状态、审查与完整报告", schema: { taskId: z.string().uuid() } },
    { name: "wait_tasks", description: "有界等待本次任务交付；pending 时宿主负责后续汇总唤醒", schema: { taskIds: z.array(z.string().uuid()).min(1).max(COLLABORATION_LIMITS.maxDeliveries) } },
  ];
  return definitions.map(definition => ({ ...definition, execute: input => call(definition.name, input) }));
}
