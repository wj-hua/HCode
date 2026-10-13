// 草案经公开服务和真实持久化验证；仅模拟模型/CLI 传输，保留启动与审查编排。
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentKind } from "../../../shared/types.js";
import type { AgentProvider, AgentSendParams } from "../../agents/types.js";
import { researchTools } from "../../sessions/researchRuntime.js";
import { AgentRegistry } from "../../agents/registry.js";
import { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import { CollaborationRepository } from "../collaborationRepository.js";
import { CollaborationService } from "../collaborationService.js";
import { ResearchDraftService } from "../drafts/researchDraftService.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hcode-draft-"));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "source.ts"), "export const answer = 42;\n");
  const agents = new AgentRegistry(Object.fromEntries((["claude", "codex"] as const).map(kind => [kind, {
    kind, getStatus: async () => ({ kind, found: true, version: "0.162.0" }),
    hasSession: () => true, endResearch: vi.fn(async () => {}),
  }])) as unknown as Record<AgentKind, AgentProvider>);
  const send = vi.fn(async (_input: AgentSendParams): Promise<{ sessionKey: string }> => { throw new Error("创建草案不得调用模型"); });
  const interrupt = vi.fn(async (_key: string) => {});
  const execution = new SessionExecutionService({ prepare: async input => input, send, interrupt, failedToSend: () => {}, finishedSending: () => {} });
  const repository = new CollaborationRepository(join(root, "runs"));
  const collaboration = new CollaborationService(repository, execution, agents, () => {}, "darwin");
  const drafts = new ResearchDraftService(join(root, "drafts"), collaboration, execution, agents);
  return { root, project, send, interrupt, execution, agents, repository, collaboration, drafts, cleanup: async () => { drafts.dispose(); collaboration.dispose(); await rm(root, { recursive: true, force: true }); } };
}

it("创建、编辑和放弃草案不调用模型、不创建 Run、不修改项目", async () => {
  const data = await fixture();
  try {
    const draft = await data.drafts.create({ initiator: { agent: "codex", sessionKey: randomUUID(), projectPath: data.project, permissionMode: "full-access" }, executor: { agent: "claude" }, objective: "只读核对 source.ts" });
    expect(draft.status).toBe("editing");
    const edited = await data.drafts.update(draft.id, draft.revision, { objective: "逐字核对 source.ts 的常量", executor: { agent: "claude" } });
    await expect(data.drafts.update(draft.id, draft.revision, { objective: "旧版本", executor: { agent: "claude" } })).rejects.toThrow("版本");
    expect((await data.drafts.get(draft.id)).revision).toBe(edited.revision);
    await data.drafts.abandon(draft.id, edited.revision);
    expect((await data.drafts.get(draft.id)).status).toBe("abandoned");
    expect(data.send).not.toHaveBeenCalled();
    expect(await data.repository.list()).toEqual([]);
    expect(await readdir(data.project)).toEqual(["source.ts"]);
    expect(await readFile(join(data.project, "source.ts"), "utf8")).toBe("export const answer = 42;\n");
  } finally { await data.cleanup(); }
});

async function preparedFixture(output?: string) {
  const data = await fixture();
  data.send.mockImplementation(async input => {
    await researchTools(input.research!).find(tool => tool.name === "read_file")!.execute({ path: "source.ts" });
    data.execution.acceptOutcome({ sessionKey: input.sessionKey, agent: input.agent, executionTurnId: input.executionTurnId!, nativeSessionId: `native-${input.sessionKey}`, outcome: "succeeded", text: output ?? JSON.stringify({ taskObjective: "逐字核对 source.ts", summary: "执行后独立审查", sources: ["source.ts"] }) });
    return { sessionKey: input.sessionKey };
  });
  const draft = await data.drafts.create({ initiator: { agent: "codex", sessionKey: randomUUID(), projectPath: data.project, permissionMode: "full-access" }, executor: { agent: "claude" }, objective: "只读核对 source.ts" });
  return { ...data, draft };
}

it("计划所读文件变化时拒绝开始，并保留待确认内容", async () => {
  const data = await preparedFixture();
  try {
    const draft = await data.drafts.prepare(data.draft.id, data.draft.revision);
    await writeFile(join(data.project, "source.ts"), "export const answer = 43;\n");
    await expect(data.drafts.confirm(draft.id, draft.revision)).rejects.toThrow("文件已变化");
    expect(await data.repository.list()).toEqual([]);
    expect(data.send).toHaveBeenCalledTimes(1);
    expect((await data.drafts.get(draft.id)).status).toBe("ready");
  } finally { await data.cleanup(); }
});

it("无效规划不是成功，重复生成计入预算且为执行和审查保留回合", async () => {
  const data = await preparedFixture("不是 JSON 计划");
  try {
    let draft = data.draft;
    for (let attempt = 0; attempt < 9; attempt++) {
      draft = await data.drafts.prepare(draft.id, draft.revision);
      expect(draft.status).toBe("blocked");
      expect(draft.error).toBeTruthy();
    }
    await expect(data.drafts.prepare(draft.id, draft.revision)).rejects.toThrow("预算");
    await expect(data.drafts.confirm(draft.id, draft.revision)).rejects.toThrow("有效计划");
    expect(data.send).toHaveBeenCalledTimes(9);
    expect(await data.repository.list()).toEqual([]);
  } finally { await data.cleanup(); }
});

it("计划捏造未读取来源时明确阻止启动", async () => {
  const data = await preparedFixture(JSON.stringify({ taskObjective: "核对来源", summary: "尚未派发", sources: ["unread.ts"] }));
  try {
    const draft = await data.drafts.prepare(data.draft.id, data.draft.revision);
    expect(draft.status).toBe("blocked");
    expect(draft.error).toContain("未经工具读取");
    expect(await data.repository.list()).toEqual([]);
  } finally { await data.cleanup(); }
});

it.each(["cancelled", "failed"] as const)("取消规划等待原生 %s 终态，不能在生成期间确认或派发", async terminal => {
  const data = await fixture();
  let pending: AgentSendParams | undefined;
  data.send.mockImplementation(async input => { pending = input; return { sessionKey: input.sessionKey }; });
  data.interrupt.mockImplementation(async () => {
    data.execution.acceptOutcome({ sessionKey: pending!.sessionKey, agent: pending!.agent, executionTurnId: pending!.executionTurnId!, outcome: terminal, text: "", error: "原生停止诊断" });
  });
  try {
    const draft = await data.drafts.create({ initiator: { agent: "codex", sessionKey: randomUUID(), projectPath: data.project, permissionMode: "full-access" }, executor: { agent: "claude" }, objective: "只读核对" });
    const preparing = data.drafts.prepare(draft.id, draft.revision);
    await vi.waitFor(() => expect(pending).toBeTruthy());
    await expect(data.drafts.confirm(draft.id, draft.revision + 1)).rejects.toThrow("正在");
    data.drafts.cancel(draft.id);
    const stopped = await preparing;
    expect(stopped.status).toBe("cancelled");
    expect(stopped.turns[0]!.status).toBe(terminal);
    expect(stopped.error).toContain("规划已取消");
    expect(stopped.error).not.toContain("原生停止诊断");
    expect(data.execution.isReserved(draft.params.initiator.sessionKey)).toBe(false);
    expect(await data.repository.list()).toEqual([]);
    expect(data.agents.get("codex").endResearch).toHaveBeenCalledWith(draft.params.initiator.sessionKey, "full-access");
  } finally { await data.cleanup(); }
});

it("模型能力失效或历史线程缺工具时不调用模型，也不替换线程", async () => {
  const data = await fixture();
  data.agents.get("codex").collaborationSourceReason = async () => "历史线程缺少委派工具";
  try {
    const draft = await data.drafts.create({ initiator: { agent: "codex", sessionKey: randomUUID(), resumeSessionId: "existing-native", projectPath: data.project, permissionMode: "full-access" }, executor: { agent: "claude" }, objective: "只读核对" });
    await expect(data.drafts.prepare(draft.id, draft.revision)).rejects.toThrow("历史线程");
    expect((await data.drafts.get(draft.id)).params.initiator.resumeSessionId).toBe("existing-native");
    expect(data.send).not.toHaveBeenCalled();
  } finally { await data.cleanup(); }
});

it("草案保存失败或执行记录不可写时不启动模型任务", async () => {
  const data = await fixture();
  try {
    await writeFile(join(data.root, "drafts"), "不是目录");
    await expect(data.drafts.create({ initiator: { agent: "codex", sessionKey: randomUUID(), projectPath: data.project, permissionMode: "read-only" }, executor: { agent: "claude" }, objective: "核对" })).rejects.toThrow();
    expect(data.send).not.toHaveBeenCalled();
  } finally { await data.cleanup(); }
  const prepared = await preparedFixture();
  try {
    const draft = await prepared.drafts.prepare(prepared.draft.id, prepared.draft.revision);
    await writeFile(prepared.repository.root, "不是目录");
    await expect(prepared.drafts.confirm(draft.id, draft.revision)).rejects.toThrow();
    expect(prepared.send).toHaveBeenCalledTimes(1);
    expect((await prepared.drafts.get(draft.id)).status).toBe("starting");
  } finally { await prepared.cleanup(); }
});

it("重启只展示未知规划状态，不能自动执行或把未知回合当作成功", async () => {
  const data = await preparedFixture();
  try {
    const draft = await data.drafts.prepare(data.draft.id, data.draft.revision);
    draft.status = "preparing"; draft.turns[0]!.status = "running";
    await data.drafts.repository.save(draft);
    const path = join(data.root, "drafts", `${draft.id}.json`);
    const before = await readFile(path, "utf8");
    const restored = new ResearchDraftService(join(data.root, "drafts"), data.collaboration, data.execution, data.agents);
    expect((await restored.get(draft.id)).status).toBe("blocked");
    await expect(restored.prepare(draft.id, draft.revision)).rejects.toThrow("原生停止状态未知");
    expect(await readFile(path, "utf8")).toBe(before);
    expect(data.send).toHaveBeenCalledTimes(1);
    expect(await data.repository.list()).toEqual([]);
  } finally { await data.cleanup(); }
});

it("历史视图重开时仅用原生身份找回待确认草案，不生成新计划", async () => {
  const data = await preparedFixture();
  try {
    const ready = await data.drafts.prepare(data.draft.id, data.draft.revision);
    const restored = new ResearchDraftService(join(data.root, "drafts"), data.collaboration, data.execution, data.agents);
    const drafts = await restored.list(undefined, ready.params.initiator.resumeSessionId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.id).toBe(ready.id);
    expect(drafts[0]!.status).toBe("ready");
    await expect(restored.list()).rejects.toThrow("会话身份");
    expect(data.send).toHaveBeenCalledTimes(1);
    expect(await data.repository.list()).toEqual([]);
  } finally { await data.cleanup(); }
});

it("模型发送前的临时持久化通知失败不遗留运行回合，重试仍能生成有效计划", async () => {
  const data = await preparedFixture();
  let failOnce = true;
  const drafts = new ResearchDraftService(join(data.root, "drafts"), data.collaboration, data.execution, data.agents, draft => {
    if (draft.status === "preparing" && failOnce) { failOnce = false; throw new Error("持久化通知失败"); }
  });
  try {
    const failed = await drafts.prepare(data.draft.id, data.draft.revision);
    expect(failed.status).toBe("blocked");
    expect(failed.turns[0]!.status).toBe("interrupted");
    expect(data.send).not.toHaveBeenCalled();
    const ready = await drafts.prepare(failed.id, failed.revision);
    expect(ready.status).toBe("ready");
    expect(ready.turns.every(turn => turn.status !== "running")).toBe(true);
  } finally { await data.cleanup(); }
});

it("生成计划拒绝派发；新版本确认只执行一次并复用原会话和规划预算", async () => {
  const data = await fixture();
  const key = randomUUID();
  let sourceTurns = 0;
  let reviews = 0;
  data.send.mockImplementation(async input => {
    let text: string;
    if (input.sessionKey === key && sourceTurns++ === 0) {
      await expect(input.research!.tools!.find(tool => tool.name === "delegate_task")!.execute({ requestKey: "escape", objective: "不得启动" })).rejects.toThrow("计划");
      await researchTools(input.research!).find(tool => tool.name === "read_file")!.execute({ path: "source.ts" });
      text = JSON.stringify({ taskObjective: "逐字核对 source.ts 的常量，并说明未运行测试", summary: "一项只读核对，独立审查后回到本会话汇总；当前尚未启动", sources: ["source.ts"] });
    } else if (input.sessionKey === key) {
      expect(input.resumeSessionId).toBe(`native-${key}`);
      text = "汇总已审查报告，未运行测试";
    } else if (input.agent === "claude") {
      text = JSON.stringify({ summary: reviews ? "已覆盖边界" : "常量为 42", findings: [{ id: "constant", title: "常量", detail: "导出常量为 42", evidence: [{ path: "source.ts", startLine: 1, endLine: 1, quote: "export const answer = 42;" }] }], limitations: ["未运行测试"] });
    } else {
      text = JSON.stringify(reviews++ === 0 ? { verdict: "changesRequested", summary: "请补充核对范围", issues: [{ id: "scope", blocking: true, location: "constant", reason: "范围缺口", evidence: "首稿未说明", suggestion: "明确范围" }] } : { verdict: "approved", summary: "完成核对", issues: [] });
    }
    data.execution.acceptOutcome({ sessionKey: input.sessionKey, agent: input.agent, executionTurnId: input.executionTurnId!, nativeSessionId: `native-${input.sessionKey}`, outcome: "succeeded", text });
    return { sessionKey: input.sessionKey };
  });
  try {
    const draft = await data.drafts.create({ initiator: { agent: "codex", sessionKey: key, projectPath: data.project, permissionMode: "full-access" }, executor: { agent: "claude" }, objective: "核对 source.ts" });
    const prepared = await data.drafts.prepare(draft.id, draft.revision);
    expect(prepared.status).toBe("ready");
    expect(prepared.params.objective).not.toContain("当前尚未启动");
    expect(prepared.turns).toHaveLength(1);
    expect(await data.repository.list()).toEqual([]);
    expect(data.send).toHaveBeenCalledTimes(1);
    const edited = await data.drafts.update(prepared.id, prepared.revision, { objective: prepared.params.objective + "；保留局限", executor: { agent: "claude" } });
    await expect(data.drafts.confirm(prepared.id, prepared.revision)).rejects.toThrow("版本");
    const [first, second] = await Promise.all([data.drafts.confirm(edited.id, edited.revision), data.drafts.confirm(edited.id, edited.revision)]);
    expect(first.id).toBe(second.id);
    await vi.waitFor(async () => expect((await data.collaboration.get(first.id)).status).toBe("completed"));
    const final = await data.collaboration.get(first.id);
    expect(final.tasks.filter(task => task.role === "planning")).toHaveLength(1);
    expect(final.tasks).toHaveLength(6);
    expect(final.deliveries).toHaveLength(1);
    expect(final.deliveries[0]!.reviews.map(review => review.verdict)).toEqual(["changesRequested", "approved"]);
    expect(final.params.initiator.resumeSessionId).toBe(`native-${key}`);
    expect((await data.repository.list())).toHaveLength(1);
    const recovered = new ResearchDraftService(join(data.root, "drafts"), data.collaboration, data.execution, data.agents);
    expect((await recovered.confirm(edited.id, edited.revision)).id).toBe(first.id);
    expect(await readdir(data.project)).toEqual(["source.ts"]);
    expect(await readFile(join(data.project, "source.ts"), "utf8")).toBe("export const answer = 42;\n");
  } finally { await data.cleanup(); }
});
