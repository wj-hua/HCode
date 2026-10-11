// 通过公开工具边界验证任务图内澄清、幂等、用户决定与跨任务隔离。
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { TaskMessages } from "../taskMessages.js";
import type { CollaborationSnapshot, DeliverySnapshot } from "../../../shared/collaboration.js";

it("澄清有界返回且重复请求不重复投递，回复绑定原问题", async () => {
  const delivery: DeliverySnapshot = { id: randomUUID(), requestKey: "task", objective: "需求", executor: { agent: "codex" }, status: "executing", versions: [], reviews: [] };
  const snapshot = { id: randomUUID(), status: "running", deliveries: [delivery], messages: [] } as unknown as CollaborationSnapshot;
  let saves = 0;
  const messages = new TaskMessages(snapshot, async () => { saves++; });
  const request = messages.workerTools(delivery, randomUUID())[0]!;
  const first = await request.execute({ requestKey: "context", question: "零值是否允许？", requiresUser: true }) as { messageId: string };
  expect(await request.execute({ requestKey: "context", question: "零值是否允许？", requiresUser: true })).toEqual(first);
  expect(messages.pending(delivery.id)).toHaveLength(1);
  await expect(messages.reply(first.messageId, "允许", "initiator")).rejects.toThrow("用户");
  await messages.reply(first.messageId, "允许", "user");
  await messages.reply(first.messageId, "允许", "user");
  await expect(messages.reply(first.messageId, "不允许", "user")).rejects.toThrow("已回复");
  await expect(messages.reply(randomUUID(), "允许", "user")).rejects.toThrow("本次");
  expect(messages.pending(delivery.id)).toHaveLength(0);
  expect(messages.context(delivery.id)).toContain("允许");
  expect(snapshot.messages).toHaveLength(2);
  expect(saves).toBe(2);
});
