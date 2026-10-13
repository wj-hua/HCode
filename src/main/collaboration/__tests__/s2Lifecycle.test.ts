// 只替换原生模型传输；公开服务动作运行真实调度、消息、证据与事件持久化。
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentKind } from "../../../shared/types.js";
import type { AgentProvider, AgentSendParams } from "../../agents/types.js";
import type { CollaborationSnapshot, TurnResult } from "../../../shared/collaboration.js";
import { AgentRegistry } from "../../agents/registry.js";
import { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import { CollaborationRepository } from "../collaborationRepository.js";
import { CollaborationService } from "../collaborationService.js";

const report = JSON.stringify({ summary: "可核对报告", findings: [{ id: "fact", title: "值", detail: "源码值为42", evidence: [{ path: "source.ts", startLine: 1, endLine: 1, quote: "export const answer = 42;" }] }], limitations: ["未运行测试"] });
async function fixture(worker: (input: AgentSendParams, count: number) => Promise<string | undefined>, parentReply = false, confirmStop = true, holdSynthesis = false, deliveryCount = 1, holdPlanning = false) {
  const root = await mkdtemp(join(tmpdir(), "hcode-s2-"));
  await writeFile(join(root, "source.ts"), "export const answer = 42;\n");
  const key = randomUUID();
  let latest: CollaborationSnapshot | undefined;
  let sourceTurns = 0;
  let workerTurns = 0;
  const inputs: AgentSendParams[] = [];
  const pending = new Map<string, AgentSendParams>();
  let execution: SessionExecutionService;
  const finish = (input: AgentSendParams, text: string, outcome: TurnResult = "succeeded") => {
    pending.delete(input.sessionKey);
    execution.acceptOutcome({ sessionKey: input.sessionKey, agent: input.agent, executionTurnId: input.executionTurnId!, nativeSessionId: `native-${input.sessionKey}`, outcome, text });
  };
  const send = async (input: AgentSendParams) => {
    inputs.push(input); pending.set(input.sessionKey, input);
    void (async () => {
      if (input.sessionKey === key) {
        sourceTurns++;
        if (sourceTurns === 1) {
          const tools = input.research!.tools!;
          const first = await tools.find((entry) => entry.name === "delegate_task")!.execute({ requestKey: "only", objective: "研究 source.ts，必要时澄清" }) as { taskId: string };
          const taskIds = [first.taskId];
          for (let index = 1; index < deliveryCount; index++) {
            const other = await tools.find((entry) => entry.name === "delegate_task")!.execute({ requestKey: `task-${index}`, objective: "独立调研" }) as { taskId: string };
            taskIds.push(other.taskId);
          }
          const waiting = await tools.find((entry) => entry.name === "wait_tasks")!.execute({ taskIds }) as { needsInput: unknown[] }[];
          if (parentReply) {
            expect(waiting[0]!.needsInput).toHaveLength(1);
            const questions = await tools.find((entry) => entry.name === "get_context_requests")!.execute({}) as { id: string }[];
            await tools.find((entry) => entry.name === "reply_context")!.execute({ messageId: questions[0]!.id, text: "已有上下文：42 是允许值" });
          }
        }
        if (sourceTurns === 1 && holdPlanning || sourceTurns > 1 && holdSynthesis) return;
        if (pending.has(input.sessionKey)) finish(input, "父会话汇总真实状态");
      } else if (input.agent === "codex") {
        const text = await worker(input, ++workerTurns);
        if (text !== undefined && pending.has(input.sessionKey)) finish(input, text);
      } else finish(input, JSON.stringify({ verdict: "approved", summary: "证据与目标一致", issues: [] }));
    })().catch((error) => finish(input, "", "failed"));
    return { sessionKey: input.sessionKey };
  };
  execution = new SessionExecutionService({ prepare: async (input) => input, send, interrupt: async (sessionKey) => {
    if (!confirmStop) throw new Error("transport unavailable");
    const input = pending.get(sessionKey); if (input) finish(input, "", "cancelled");
  }, failedToSend: () => {}, finishedSending: () => {} });
  const agents = new AgentRegistry(Object.fromEntries((["claude", "codex"] as const).map((kind) => [kind, { kind, getStatus: async () => ({ kind, found: true, version: "0.162.0" }), hasSession: () => false }])) as unknown as Record<AgentKind, AgentProvider>);
  const repository = new CollaborationRepository(join(root, "records"));
  const service = new CollaborationService(repository, execution, agents, (value) => { latest = value; }, "darwin");
  const start = () => service.start({ initiator: { agent: "claude", sessionKey: key, projectPath: root, permissionMode: "default" }, executor: { agent: "codex" }, objective: "研究" });
  return { root, key, inputs, service, repository, execution, start, latest: () => latest!, finishPlanning: () => finish(pending.get(key)!, "父会话交回宿主"), cleanup: async () => {
    if (latest && ["running", "stopping"].includes(latest.status)) await service.cancel(latest.id);
    if (latest) { await vi.waitFor(() => expect(latest!.stage).toBe("finished")); await service.get(latest.id); }
    service.dispose(); await rm(root, { recursive: true, force: true });
  } };
}

it.each([false, true])("澄清释放 wait_tasks，%s 发起者代答，用户操作后在原执行会话续跑", async (parentReply) => {
  const data = await fixture(async (input, count) => {
    if (count === 1) { await input.research!.tools![0]!.execute({ requestKey: "q", question: "42 是否允许？", requiresUser: !parentReply }); return "等待上下文"; }
    expect(input.text).toContain("42 是允许值");
    expect(input.resumeSessionId).toBe(`native-${input.sessionKey}`);
    return report;
  }, parentReply);
  try {
    const run = await data.start();
    await vi.waitFor(() => expect(data.latest().stage).toBe("finished"));
    if (!parentReply) {
      expect(data.latest().status).toBe("awaitingUser");
      expect(data.latest().deliveries[0]!.versions).toHaveLength(0);
      const question = data.latest().messages![0]!;
      await expect(data.service.controls.resume(run.id, { action: "execute" })).rejects.toThrow("澄清");
      await data.service.controls.reply(run.id, question.id, "用户决定：42 是允许值");
      await data.service.controls.resume(run.id, { action: "execute" });
      await vi.waitFor(() => expect(data.latest().status).toBe("completed"));
    }
    expect(data.latest().status).toBe("completed");
    expect(data.inputs.filter((input) => input.agent === "codex")).toHaveLength(2);
    expect(data.latest().messages).toHaveLength(2);
  } finally { await data.cleanup(); }
});

it("原会话仍活动时保存用户回复不自动续跑，结束后等待用户明确选择", async () => {
  const data = await fixture(async (input, count) => {
    if (count !== 1) return report;
    await input.research!.tools![0]!.execute({ requestKey: "q", question: "用户期望值？", requiresUser: true });
    return "等待用户决定";
  }, false, true, false, 1, true);
  try {
    const run = await data.start();
    await vi.waitFor(() => expect(data.latest().deliveries[0]?.status).toBe("awaitingUser"));
    expect(data.latest().status).toBe("running");
    await data.service.controls.reply(run.id, data.latest().messages![0]!.id, "期望值42");
    data.finishPlanning();
    await vi.waitFor(() => expect(data.latest().stage).toBe("finished"));
    expect(data.latest().status).toBe("awaitingUser");
    expect(data.inputs.filter(input => input.agent === "codex")).toHaveLength(1);
    await data.service.controls.resume(run.id, { deliveryId: data.latest().deliveries[0]!.id, action: "execute" });
    await vi.waitFor(() => expect(data.latest().status).toBe("completed"));
  } finally { await data.cleanup(); }
});

it("续跑时重复读取已回答的问题能拿到真实答案，原会话汇总也可读取此任务消息", async () => {
  const data = await fixture(async (input, count) => {
    const question = await input.research!.tools![0]!.execute({ requestKey: "decision", question: "产品期望值？", requiresUser: true }) as { answered?: boolean; answer?: { text: string } };
    if (count === 1 || !question.answered) return JSON.stringify({ summary: "等待用户", findings: [], limitations: [] });
    expect(question.answer?.text).toBe("用户期望值42");
    return report;
  });
  try {
    const run = await data.start();
    await vi.waitFor(() => expect(data.latest().stage).toBe("finished"));
    await data.service.controls.reply(run.id, data.latest().messages![0]!.id, "用户期望值42");
    const deliveryId = data.latest().deliveries[0]!.id;
    await data.service.controls.resume(run.id, { deliveryId, action: "execute" });
    await vi.waitFor(() => expect(data.latest().stage).toBe("finished"));
    expect(data.latest().status).toBe("completed");
    const summaryInput = data.inputs.at(-1)!;
    const result = await summaryInput.research!.tools!.find(tool => tool.name === "get_task_result")!.execute({ taskId: deliveryId });
    expect(JSON.stringify(result)).toContain("用户期望值42");
  } finally { await data.cleanup(); }
});

it.each([true, false])("暂停必须收到原生确认（%s），接管前保持停止中状态", async (confirmed) => {
  const data = await fixture(async (_input, count) => count === 1 ? undefined : report, false, confirmed);
  try {
    const run = await data.start();
    await vi.waitFor(() => expect(data.inputs.some((input) => input.agent === "codex")).toBe(true));
    await expect(data.service.controls.takeover(run.id)).rejects.toThrow("暂停");
    await data.service.controls.stop(run.id, "pause");
    await vi.waitFor(() => expect(data.latest().stage).toBe("finished"));
    expect(data.latest().status).toBe(confirmed ? "paused" : "stopping");
    if (!confirmed) {
      await expect(data.service.controls.takeover(run.id)).rejects.toThrow("确认");
      expect(data.latest().error).toContain("未获原生确认");
      await expect(data.service.controls.resume(run.id, { action: "execute" })).rejects.toThrow("活动回合");
      expect(() => data.execution.assertIdle(data.inputs.find(input => input.agent === "codex")!.sessionKey)).toThrow("未知");
      expect((await data.service.get(run.id)).status).toBe("stopping");
      const worker = data.inputs.find(input => input.agent === "codex")!;
      data.execution.acceptOutcome({ sessionKey: worker.sessionKey, agent: worker.agent, executionTurnId: worker.executionTurnId!, outcome: "cancelled", text: "" });
      expect((await data.service.get(run.id)).status).toBe("paused");
      await data.service.controls.takeover(run.id);
    } else {
      await data.service.controls.takeover(run.id);
      expect(data.latest().tasks.every((task) => task.status !== "running")).toBe(true);
      const reopened = new CollaborationService(data.repository, data.execution, {} as AgentRegistry, () => {});
      expect((await reopened.get(run.id)).status).toBe("paused");
      expect(data.inputs.filter((input) => input.agent === "codex")).toHaveLength(1);
      expect(data.latest().deliveries[0]!.status).toBe("interrupted");
      await data.service.controls.resume(run.id, { action: "execute" });
      await vi.waitFor(() => expect(data.latest().status).toBe("completed"));
    }
  } finally { await data.cleanup(); }
});

it("定向保存资料后重启仅展示；明确续跑一个任务保留另一份已接受报告", async () => {
  const data = await fixture(async (input, count) => {
    if (count !== 1) return report;
    await input.research!.tools![0]!.execute({ requestKey: "question", question: "期望值？", requiresUser: true });
    return "缺少资料";
  }, false, true, false, 2);
  try {
    const run = await data.start();
    await vi.waitFor(() => expect(data.latest().stage).toBe("finished"));
    const saved = await data.service.get(run.id);
    const blocked = saved.deliveries.find(entry => entry.status !== "accepted")!;
    const accepted = saved.deliveries.find(entry => entry.status === "accepted")!;
    const before = data.inputs.length;
    await data.service.controls.reply(run.id, saved.messages![0]!.id, "期望值为42");
    await data.service.controls.supplement(run.id, blocked.id, "指定任务补充：实际值为42，请读取源码核对");
    expect(data.inputs).toHaveLength(before);
    const reopened = new CollaborationService(data.repository, data.execution, {} as AgentRegistry, () => {});
    const recovered = await reopened.get(run.id);
    expect(recovered.messages!.at(-1)?.deliveryId).toBe(blocked.id);
    expect(recovered.messages!.at(-1)?.text).toContain("实际值为42");
    expect(data.inputs).toHaveLength(before);
    await expect(data.service.controls.supplement(run.id, randomUUID(), "错误目标")).rejects.toThrow("不属于");
    await data.service.controls.resume(run.id, { deliveryId: blocked.id, action: "execute" });
    await vi.waitFor(() => expect(data.latest().status).toBe("completed"));
    const final = await data.service.get(run.id);
    expect(final.deliveries.find(entry => entry.id === accepted.id)).toEqual(accepted);
    const newWorkers = data.inputs.slice(before).filter(input => input.agent === "codex");
    expect(newWorkers).toHaveLength(1);
    expect(newWorkers[0]!.text).toContain("指定任务补充");
  } finally { await data.cleanup(); }
});

it("用户重新审查保留历史；源文件变化不能沿用旧通过", async () => {
  const data = await fixture(async () => report);
  try {
    const run = await data.start();
    await vi.waitFor(() => expect(data.latest().status).toBe("completed"));
    const deliveryId = data.latest().deliveries[0]!.id;
    await data.service.controls.resume(run.id, { action: "review", deliveryId });
    await vi.waitFor(() => expect(data.latest().status).toBe("completed"));
    expect(data.latest().deliveries[0]!.reviews).toHaveLength(2);
    expect(data.latest().deliveries[0]!.versions).toHaveLength(1);
    await writeFile(join(data.root, "source.ts"), "export const answer = 43;\n");
    await expect(data.service.controls.resume(run.id, { action: "review", deliveryId })).rejects.toThrow("变化");
    const reopened = new CollaborationService(data.repository, data.execution, {} as AgentRegistry, () => {});
    const before = data.inputs.length;
    expect((await reopened.get(run.id)).deliveries[0]!.reviews).toHaveLength(2);
    expect(data.inputs).toHaveLength(before);
  } finally { await data.cleanup(); }
});

it("给已接受任务补资料使旧汇总失效，旧报告和审查保留且不自动执行", async () => {
  const data = await fixture(async () => report);
  try {
    const run = await data.start();
    await vi.waitFor(() => expect(data.latest().status).toBe("completed"));
    const before = await data.service.get(run.id), target = before.deliveries[0]!;
    const inputCount = data.inputs.length;
    await data.service.controls.supplement(run.id, target.id, "产品资料已更新，请重新核对结论");
    const saved = await data.service.get(run.id);
    expect(saved.status).toBe("awaitingUser");
    expect(saved.summary).toBeUndefined();
    expect(saved.deliveries[0]!.status).toBe("awaitingUser");
    expect(saved.deliveries[0]!.versions).toEqual(target.versions);
    expect(saved.deliveries[0]!.reviews).toEqual(target.reviews);
    expect(data.inputs).toHaveLength(inputCount);
  } finally { await data.cleanup(); }
});

it("任务级取消只终结选定交付，父会话保留失败汇总且不进入审查", async () => {
  const data = await fixture(async () => undefined);
  try {
    const run = await data.start();
    await vi.waitFor(() => expect(data.inputs.some((input) => input.agent === "codex")).toBe(true));
    await data.service.controls.cancelDelivery(run.id, data.latest().deliveries[0]!.id);
    await vi.waitFor(() => expect(data.latest().stage).toBe("finished"));
    expect(data.latest().deliveries[0]!.status).toBe("cancelled");
    expect(data.latest().tasks.some((task) => task.role === "review")).toBe(false);
    expect(data.latest().tasks.find((task) => task.role === "synthesis")?.status).toBe("succeeded");
    expect(data.latest().status).toBe("failed");
  } finally { await data.cleanup(); }
});

it("重启未知执行状态仅展示 interrupted，不自动派发；整体取消不触发汇总", async () => {
  const data = await fixture(async () => undefined);
  try {
    const run = await data.start();
    await vi.waitFor(() => expect(data.inputs.some((input) => input.agent === "codex")).toBe(true));
    const reopened = new CollaborationService(data.repository, data.execution, {} as AgentRegistry, () => {});
    const before = data.inputs.length;
    expect((await reopened.get(run.id)).status).toBe("interrupted");
    expect(data.inputs).toHaveLength(before);
    await data.service.cancel(run.id);
    await vi.waitFor(() => expect(data.latest().stage).toBe("finished"));
    expect(data.latest().status).toBe("cancelled");
    expect(data.latest().tasks.some((task) => task.role === "synthesis")).toBe(false);
    expect(data.latest().deliveries.every((delivery) => delivery.status === "cancelled")).toBe(true);
  } finally { await data.cleanup(); }
});

it("人工重审不会重置累计预算，耗尽后不再调用模型", async () => {
  const data = await fixture(async () => report);
  try {
    const run = await data.start();
    await vi.waitFor(() => expect(data.latest().status).toBe("completed"));
    const deliveryId = data.latest().deliveries[0]!.id;
    for (let retry = 0; retry < 4; retry++) {
      await data.service.controls.resume(run.id, { action: "review", deliveryId });
      await vi.waitFor(() => expect(data.latest().status).toBe("completed"));
    }
    expect(data.latest().tasks).toHaveLength(12);
    const before = data.inputs.length;
    await expect(data.service.controls.resume(run.id, { action: "review", deliveryId })).rejects.toThrow("累计回合预算不足");
    expect(data.inputs).toHaveLength(before);
    expect(data.latest().deliveries[0]!.reviews).toHaveLength(5);
  } finally { await data.cleanup(); }
});

it("待澄清的父会话汇总仍属活动阶段，可可信取消，不能提前开放普通发送", async () => {
  const data = await fixture(async (input) => {
    await input.research!.tools![0]!.execute({ requestKey: "q", question: "产品规则？", requiresUser: true });
    return "等待用户";
  }, false, true, true);
  try {
    const run = await data.start();
    await vi.waitFor(() => expect(data.latest().stage).toBe("synthesis"));
    expect(data.latest().status).toBe("running");
    await data.service.cancel(run.id);
    await vi.waitFor(() => expect(data.latest().stage).toBe("finished"));
    expect(data.latest().status).toBe("cancelled");
    expect(data.latest().tasks.at(-1)?.status).toBe("cancelled");
    expect(data.latest().deliveries[0]!.status).toBe("cancelled");
  } finally { await data.cleanup(); }
});

it("两个活动工作者和一个排队任务全部取消；排队者不启动，迟到成功不唤醒父 AI", async () => {
  const data = await fixture(async () => undefined, false, true, false, 3);
  try {
    const run = await data.start();
    await vi.waitFor(() => expect(data.latest().deliveries).toHaveLength(3));
    await vi.waitFor(() => expect(data.inputs.filter((input) => input.agent === "codex")).toHaveLength(2));
    await data.service.cancel(run.id);
    await vi.waitFor(() => expect(data.latest().stage).toBe("finished"));
    expect(data.latest().deliveries.every((delivery) => delivery.status === "cancelled")).toBe(true);
    const before = data.inputs.length;
    const old = data.inputs.find((input) => input.agent === "codex")!;
    data.execution.acceptOutcome({ sessionKey: old.sessionKey, agent: "codex", executionTurnId: old.executionTurnId!, outcome: "succeeded", text: report });
    expect(data.latest().status).toBe("cancelled");
    expect(data.inputs).toHaveLength(before);
    expect(data.latest().tasks.some((task) => task.role === "synthesis")).toBe(false);
  } finally { await data.cleanup(); }
});
