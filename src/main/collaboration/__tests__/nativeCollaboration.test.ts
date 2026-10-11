// 真实委派与故意缩窄首稿的修订验收；结果、阻塞意见和修订全部由原生模型产生。
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("../../util/trash.js", () => ({ trashPaths: async () => { throw new Error("原生研究验证禁止删除历史"); } }));
import { nativeFixture } from "./nativeFixture.js";

it.skipIf(process.env.HCODE_NATIVE_SMOKE !== "1")("S1 真实委派、独立审查和原会话汇总", async () => {
  const data = await nativeFixture("hcode-s1-native-");
  const { root, service, repository } = data;
  try {
    await writeFile(join(root, "source.ts"), "export function divide(value: number, divisor: number) {\n  return value / divisor;\n}\n");
    const start = await service.start({ initiator: { agent: "claude", sessionKey: randomUUID(), projectPath: root, permissionMode: "default", model: "sonnet" }, executor: { agent: "codex" }, objective: "只创建一个任务，调研 source.ts 的 divide 在 divisor=0 时的 JavaScript 行为与局限，不修改源码。报告引用函数实际完整源码行，说明未运行测试。" });
    await vi.waitFor(() => expect(data.latest()?.stage).toBe("finished"), { timeout: 300_000, interval: 1000 });
    const result = await service.get(start.id);
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(result.deliveries).toHaveLength(1);
    const delivery = result.deliveries[0]!;
    expect(delivery.status).toBe("accepted");
    expect(delivery.reviews.at(-1)?.reviewer?.agent).toBe("claude");
    expect(delivery.reviews.at(-1)?.reviewer?.nativeSessionId).toBeTruthy();
    expect(delivery.reviews.at(-1)?.versionId).toBe(delivery.versions.at(-1)?.id);
    expect(result.tasks.map((task) => task.role)).toEqual(expect.arrayContaining(["planning", "execution", "review", "synthesis"]));
    expect(result.tasks.every((task) => task.status === "succeeded" && task.nativeSessionId)).toBe(true);
    const parent = result.tasks.filter((task) => task.role === "planning" || task.role === "synthesis");
    expect(parent[0]!.nativeSessionId).toBe(parent[1]!.nativeSessionId);
    expect(result.summary).toBeTruthy();
    expect((await repository.load(start.id)).status).toBe("completed");
    expect((await service.artifact(start.id, delivery.versions.at(-1)!.id)).markdown).toContain("source.ts");
  } finally { await data.cleanup(); }
}, 360_000);

it.skipIf(process.env.HCODE_NATIVE_REVISION !== "1")("S1 真实阻塞意见后的修订与独立复审", async () => {
  let omissionInjected = false;
  const data = await nativeFixture("hcode-s1-revision-", (input) => {
    // 缩窄真实执行者首版的输入；独立审查仍按完整目标判断，不预设 verdict。
    if (input.agent === "codex" && !omissionInjected) {
      omissionInjected = true;
      return { ...input, text: "你是只读研究执行者。本次初稿仅说明 source.ts 的正常正整数除法，不分析 divisor=0 或 NaN；后续审查反馈可能扩大报告覆盖范围。读取 hcode_read_file，不修改文件、不运行命令。按 JSON schema 输出带完整逐字源码引用的报告，说明未运行测试。" };
    }
    return input;
  });
  const { root, service, repository } = data;
  try {
    await writeFile(join(root, "source.ts"), "export function divide(value: number, divisor: number) {\n  return value / divisor;\n}\n");
    const start = await service.start({ initiator: { agent: "claude", sessionKey: randomUUID(), projectPath: root, permissionMode: "default", model: "sonnet" }, executor: { agent: "codex" }, objective: "只创建一个任务：调研 source.ts 的 divide。验收要求报告分别覆盖正常除法、正数除以零、零除以零，并准确解释 Infinity 与 NaN；缺任何一项是阻塞遗漏。引用实际完整源码行，说明未运行测试，不修改源码。" });
    await vi.waitFor(() => expect(data.latest()?.stage).toBe("finished"), { timeout: 420_000, interval: 1000 });
    const result = await service.get(start.id);
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect(result.deliveries).toHaveLength(1);
    const delivery = result.deliveries[0]!;
    expect(delivery.status).toBe("accepted");
    expect(delivery.versions.length).toBeGreaterThanOrEqual(2);
    expect(delivery.reviews[0]?.verdict).toBe("changesRequested");
    expect(delivery.reviews[0]?.issues.some((issue) => issue.blocking)).toBe(true);
    expect(delivery.reviews.at(-1)?.verdict).toBe("approved");
    const workerTurns = result.tasks.filter((task) => task.role === "execution");
    expect(new Set(workerTurns.map((task) => task.nativeSessionId)).size).toBe(1);
    const reviewers = result.tasks.filter((task) => task.role === "review");
    expect(new Set(reviewers.map((task) => task.nativeSessionId)).size).toBe(reviewers.length);
    expect(delivery.reviews.at(-1)?.reviewer?.agent).toBe("claude");
    expect(delivery.reviews.at(-1)?.reviewer?.nativeSessionId).toBeTruthy();
    expect(delivery.reviews.at(-1)?.versionId).toBe(delivery.versions.at(-1)?.id);
    expect(result.tasks.map((task) => task.role)).toEqual(expect.arrayContaining(["planning", "execution", "review", "synthesis"]));
    expect(result.tasks.every((task) => task.status === "succeeded" && task.nativeSessionId)).toBe(true);
    const parent = result.tasks.filter((task) => task.role === "planning" || task.role === "synthesis");
    expect(parent[0]!.nativeSessionId).toBe(parent[1]!.nativeSessionId);
    expect(result.summary).toBeTruthy();
    expect((await repository.load(start.id)).status).toBe("completed");
    expect((await service.artifact(start.id, delivery.versions.at(-1)!.id)).markdown).toContain("source.ts");
  } finally { await data.cleanup(); }
}, 480_000);
