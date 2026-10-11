// Run 内有向消息：执行者只能问自己的任务，发起者不能代替用户扩大权限或决定产品规则。
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { COLLABORATION_LIMITS } from "../../shared/collaboration.js";
import type { CollaborationSnapshot, DeliverySnapshot, TaskMessage } from "../../shared/collaboration.js";
import type { HostedTool } from "../sessions/researchRuntime.js";

export const MAX_TASK_MESSAGES = COLLABORATION_LIMITS.maxMessages;
export const MAX_CONTEXT_LENGTH = COLLABORATION_LIMITS.maxContextLength;

export class TaskMessages {
  private readonly listeners = new Set<() => void>();
  constructor(private readonly snapshot: CollaborationSnapshot, private readonly changed: () => Promise<void>) {}

  pending(deliveryId?: string) {
    const messages = this.snapshot.messages ?? [];
    return messages.filter((entry) => entry.type === "clarification" && (!deliveryId || entry.deliveryId === deliveryId) && !messages.some((reply) => reply.replyTo === entry.id));
  }

  context(deliveryId: string) {
    return JSON.stringify((this.snapshot.messages ?? []).filter((entry) => entry.deliveryId === deliveryId));
  }

  /** 等待者只接收唤醒信号；超时/取消后调用 dispose，不占工作者槽。 */
  watch() {
    let listener: () => void;
    const promise = new Promise<void>((resolve) => { listener = resolve; this.listeners.add(listener); });
    return { promise, dispose: () => this.listeners.delete(listener!) };
  }

  private async append(message: TaskMessage) {
    if ((this.snapshot.messages?.length ?? 0) >= MAX_TASK_MESSAGES) throw new Error("任务消息预算已用尽，请人工处理");
    this.snapshot.messages ??= [];
    this.snapshot.messages.push(message);
    await this.changed();
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }

  async reply(messageId: string, text: string, sender: "user" | "initiator") {
    z.string().trim().min(1).max(MAX_CONTEXT_LENGTH).parse(text);
    const question = this.pending().find((entry) => entry.id === messageId);
    if (!question) {
      const previous = this.snapshot.messages?.find((entry) => entry.replyTo === messageId);
      if (previous?.text === text && previous.sender === sender) return;
      if (previous) throw new Error("问题已回复，不能覆盖历史回复");
      throw new Error("问题不属于本次协作或不是待回复问题");
    }
    if (question.requiresUser && sender !== "user") throw new Error("该决定需要用户回复，发起 AI 不能代批");
    await this.append({ id: randomUUID(), deliveryId: question.deliveryId, requestKey: `reply:${messageId}`, replyTo: messageId, sender, recipient: "worker", type: "answer", text, createdAt: Date.now() });
  }

  async supplement(deliveryId: string, text: string) {
    z.string().trim().min(1).max(MAX_CONTEXT_LENGTH).parse(text);
    await this.append({ id: randomUUID(), deliveryId, requestKey: randomUUID(), sender: "user", recipient: "worker", type: "context", text, createdAt: Date.now() });
  }

  workerTools(delivery: DeliverySnapshot, _key: string): HostedTool[] {
    return [{ name: "request_context", description: "向发起者请求本任务上下文；涉及产品规则/权限决定必须 requiresUser=true。立即返回并结束当前回合，不等待用户、不生成猜测报告。后续回复只在回合边界续跑。", schema: { requestKey: z.string().min(1).max(120), question: z.string().min(1).max(MAX_CONTEXT_LENGTH), requiresUser: z.boolean() }, execute: async (input) => {
      if (this.snapshot.status !== "running") throw new Error("本次协作已停止派发");
      const text = String(input.question);
      const requestKey = String(input.requestKey);
      const previous = this.snapshot.messages?.find((entry) => entry.deliveryId === delivery.id && entry.type === "clarification" && entry.requestKey === requestKey);
      if (previous) {
        if (previous.text !== text || previous.requiresUser !== input.requiresUser) throw new Error("相同消息幂等键对应不同问题");
        return { messageId: previous.id };
      }
      if (this.pending(delivery.id).length) throw new Error("本任务已有待回答问题，请结束当前回合");
      const message: TaskMessage = { id: randomUUID(), deliveryId: delivery.id, requestKey, sender: "worker", recipient: "initiator", type: "clarification", text, requiresUser: input.requiresUser === true, createdAt: Date.now() };
      await this.append(message);
      return { messageId: message.id };
    } }];
  }
}
