// 全服务闭环经外部模型/CLI 传输边界验证，真实运行工具、工作流、证据与仓库。
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { CollaborationSnapshot } from "../../../shared/collaboration.js";
import type { AgentKind } from "../../../shared/types.js";
import type { AgentProvider } from "../../agents/types.js";
import { AgentRegistry } from "../../agents/registry.js";
import { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import { CollaborationRepository } from "../collaborationRepository.js";
import { CollaborationService } from "../collaborationService.js";

it.each([{ deliveryCount: 1, initiatorAgent: "claude" as const, executorAgent: "codex" as const }, { deliveryCount: 2, initiatorAgent: "claude" as const, executorAgent: "codex" as const }, { deliveryCount: 1, initiatorAgent: "codex" as const, executorAgent: "claude" as const }, { deliveryCount: 1, initiatorAgent: "claude" as const, executorAgent: "agy" as const }, { deliveryCount: 1, initiatorAgent: "codex" as const, executorAgent: "claude" as const, reviewerAgent: "agy" as const }])("$initiatorAgent 派发 $deliveryCount 项交付、修订复审并在同会话汇总", async ({ deliveryCount, initiatorAgent, executorAgent, ...options }) => {
  const reviewerAgent = "reviewerAgent" in options ? options.reviewerAgent : initiatorAgent;
  const root = await mkdtemp(join(tmpdir(), "hcode-run-test-"));
  const key = randomUUID();
  const observed: CollaborationSnapshot[] = [];
  let sourceTurns = 0;
  let workerTurns = 0;
  let reviews = 0;
  const taskIds: string[] = [];
  let restored = false;
  const agents = new AgentRegistry(Object.fromEntries((["claude", "codex", "agy"] as const).map((kind) => [kind, { kind, getStatus: async () => ({ kind, found: true, version: kind === "codex" ? "0.162.0" : kind === "agy" ? "1.3.3" : "test" }), listModels: async () => [{value:"gemini-fixture",label:"Gemini fixture"}], hasSession: () => true, endResearch: async () => { restored = true; } }])) as unknown as Record<AgentKind, AgentProvider>);
  const execution = new SessionExecutionService({ prepare: async (input) => input, interrupt: async () => {}, failedToSend: () => {}, finishedSending: () => {}, send: async (input) => {
    let text: string;
    if (input.sessionKey === key) {
      sourceTurns++;
      const tool = (name: string) => input.research!.tools!.find((entry) => entry.name === name)!;
      if (sourceTurns === 1) {
        const request = { requestKey: "task", objective: "核对 source.ts 的正常与失败行为" };
        const first = await tool("delegate_task").execute(request) as { taskId: string };
        expect(await tool("delegate_task").execute(request)).toEqual(first);
        taskIds.push(first.taskId);
        if (deliveryCount === 2) {
          const second = await tool("delegate_task").execute({ requestKey: "task-2", objective: "独立核对 source.ts 的导出行为" }) as { taskId: string };
          taskIds.push(second.taskId);
        }
        await tool("wait_tasks").execute({ taskIds });
        text = "委派已交付";
      } else {
        await expect(tool("delegate_task").execute({ requestKey: "extra", objective: "不应派发" })).rejects.toThrow("停止派发");
        expect(input.resumeSessionId).toBe(`native-${key}`);
        await expect(tool("get_task_result").execute({ taskId: randomUUID() })).rejects.toThrow("不属于");
        const results = await Promise.all(taskIds.map(async (taskId) => {
          const result = await tool("get_task_result").execute({ taskId });
          expect(result).toMatchObject({ deliveryId: taskId, reviews: expect.arrayContaining([expect.objectContaining({ reviewer: expect.objectContaining({ agent: reviewerAgent }) })]) });
          return result;
        }));
        expect(JSON.stringify(results)).toContain("包含失败行为");
        text = "汇总真实报告，未运行测试";
      }
    } else if (input.agent === executorAgent) {
      workerTurns++;
      const revised = input.text.includes("这是待核对的审查数据");
      if (revised) expect(input.text).toContain("boundary-1");
      text = JSON.stringify({ summary: !revised ? "正常行为" : "包含失败行为", findings: [{ id: "finding", title: "行为", detail: "源码常量", evidence: [{ path: "source.ts", startLine: 1, endLine: 1, quote: "export const answer = 42;" }] }], limitations: ["未运行测试"] });
    } else {
      reviews++;
      text = JSON.stringify(reviews === 1 ? { verdict: "changesRequested", summary: "遗漏边界", issues: [{ id: "boundary-1", blocking: true, location: "finding", reason: "未讨论失败", evidence: "报告仅讨论正常行为", suggestion: "补充失败行为" }] } : { verdict: "approved", summary: "目标和证据已覆盖", issues: [] });
    }
    execution.acceptOutcome({ sessionKey: input.sessionKey, agent: input.agent, executionTurnId: input.executionTurnId!, nativeSessionId: `native-${input.sessionKey}`, outcome: "succeeded", text });
    return { sessionKey: input.sessionKey };
  } });
  const repository = new CollaborationRepository(join(root, "records"));
  const service = new CollaborationService(repository, execution, agents, (snapshot) => observed.push(snapshot), "darwin");
  try {
    await writeFile(join(root, "source.ts"), "export const answer = 42;\n");
    const run = await service.start({ initiator: { agent: initiatorAgent, sessionKey: key, projectPath: root, permissionMode: "default" }, executor: { agent: executorAgent, ...(executorAgent === "agy" ? {model:"gemini-fixture"} : {}) }, ...(reviewerAgent === "agy" ? {reviewer: {agent: reviewerAgent, model:"gemini-fixture"}} : {}), objective: "委派调研" });
    await vi.waitFor(() => expect(restored).toBe(true));
    const result = await service.get(run.id);
    expect(result.status).toBe("completed");
    expect([sourceTurns, workerTurns, reviews]).toEqual([2, deliveryCount + 1, deliveryCount + 1]);
    expect(result.deliveries).toHaveLength(deliveryCount);
    expect(result.deliveries.every((delivery) => delivery.status === "accepted")).toBe(true);
    const revisedDelivery = result.deliveries.find((delivery) => delivery.versions.length === 2)!;
    expect(revisedDelivery.reviews.map((review) => review.verdict)).toEqual(["changesRequested", "approved"]);
    for (const delivery of result.deliveries) {
      expect(result.tasks.filter((task) => task.deliveryId === delivery.id).every((task) => task.status === "succeeded")).toBe(true);
      expect(delivery.reviews.at(-1)!.versionId).toBe(delivery.versions.at(-1)!.id);
    }
    expect(observed.map((snapshot) => snapshot.seq)).toEqual(Array.from({ length: result.seq }, (_, index) => index + 1));
    expect((await repository.load(run.id)).status).toBe("completed");
    const recovered = new CollaborationService(repository, execution, agents, () => {});
    expect((await recovered.list(randomUUID(), `native-${key}`)).map((entry) => entry.id)).toEqual([run.id]);
  } finally { service.dispose(); await rm(root, { recursive: true, force: true }); }
});

it("持久化失败不启动 CLI，也不留下假运行中的任务", async () => {
  const root = await mkdtemp(join(tmpdir(), "hcode-persistence-test-"));
  const records = join(root, "records");
  let sends = 0;
  let latest: CollaborationSnapshot | undefined;
  const agents = new AgentRegistry(Object.fromEntries((["claude", "codex"] as const).map((kind) => [kind, { kind, getStatus: async () => ({ kind, found: true, version: kind === "codex" ? "0.162.0" : "test" }), hasSession: () => false }])) as unknown as Record<AgentKind, AgentProvider>);
  const execution = new SessionExecutionService({ prepare: async (input) => input, interrupt: async () => {}, failedToSend: () => {}, finishedSending: () => {}, send: async (input) => { sends++; return { sessionKey: input.sessionKey }; } });
  const repository = new CollaborationRepository(records);
  const service = new CollaborationService(repository, execution, agents, (snapshot) => {
    latest = snapshot;
    if (snapshot.seq === 1) {
      // 真实文件系统故障：初始日志已落盘，此后记录目录被外部进程替换成普通文件。
      renameSync(records, join(root, "saved-records"));
      writeFileSync(records, "not a directory");
    }
  }, "darwin");
  try {
    const run = await service.start({ initiator: { agent: "claude", sessionKey: randomUUID(), projectPath: root, permissionMode: "default" }, executor: { agent: "codex" }, objective: "只读调研" });
    await vi.waitFor(() => expect(latest?.persistenceError).toBeTruthy());
    const result = await service.get(run.id);
    expect(result.status).toBe("failed");
    expect(result.tasks.every((task) => task.status !== "running")).toBe(true);
    expect(sends).toBe(0);
  } finally { service.dispose(); await rm(root, { recursive: true, force: true }); }
});
