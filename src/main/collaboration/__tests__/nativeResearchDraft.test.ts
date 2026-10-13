// U0 真实规划→确认→执行→独立审查→原会话汇总；不替换工具、模型输出或审查意见。
import { mkdir, writeFile, readFile, readdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("../../util/trash.js", () => ({ trashPaths: async () => { throw new Error("只读草案验收禁止删除历史"); } }));
import { nativeFixture } from "./nativeFixture.js";
import { ResearchDraftService } from "../drafts/researchDraftService.js";

it.skipIf(process.env.HCODE_NATIVE_DRAFT !== "1").each(["codex", "claude"] as const)("U0 %s 原会话真实草案与唯一确认闭环", async agent => {
  const data = await nativeFixture(`hcode-u0-${agent}-`);
  const project = join(data.root, "project");
  const drafts = new ResearchDraftService(join(data.root, "drafts"), data.service, data.execution, data.agents);
  const key = randomUUID();
  const content = "规则一：报告逐字引用本文件。\n规则二：仅做原文核对，不运行测试，不修改代码。\n";
  try {
    await mkdir(project);
    await writeFile(join(project, "review-context.md"), content);
    const draft = await drafts.create({ initiator: { agent, sessionKey: key, projectPath: project, permissionMode: agent === "claude" ? "bypassPermissions" : "full-access", ...(agent === "claude" ? { model: "sonnet" } : {}) }, executor: { agent: agent === "claude" ? "codex" : "claude", ...(agent === "codex" ? { model: "sonnet" } : {}) }, objective: "只安排一个只读任务：通过 hcode read_file 读取 review-context.md，报告只列两条原文规则，每条有本文件完整行的逐字证据引用；禁止扩展推论、代码修改或测试。独立审查仅核对报告是否忠实于原文，不要求代码实现。" });
    expect(await data.repository.list()).toEqual([]);
    const prepared = await drafts.prepare(draft.id, draft.revision);
    expect(prepared.status, JSON.stringify(prepared)).toBe("ready");
    expect(prepared.sources).toHaveLength(1);
    expect(prepared.turns).toHaveLength(1);
    expect(prepared.params.initiator.resumeSessionId).toBeTruthy();
    expect(await data.repository.list()).toEqual([]);
    expect(await readdir(project)).toEqual(["review-context.md"]);
    expect(await readFile(join(project, "review-context.md"), "utf8")).toBe(content);
    const edited = await drafts.update(prepared.id, prepared.revision, { objective: prepared.params.objective + "\n用户补充：最终汇总明确说明本次未运行测试。", executor: prepared.params.executor });
    await expect(drafts.confirm(prepared.id, prepared.revision)).rejects.toThrow("版本");
    const [run, repeated] = await Promise.all([drafts.confirm(edited.id, edited.revision), drafts.confirm(edited.id, edited.revision)]);
    expect(run.id).toBe(repeated.id);
    await vi.waitFor(async () => expect((await data.service.get(run.id)).stage).toBe("finished"), { timeout: 360_000, interval: 1000 });
    const final = await data.service.get(run.id);
    expect(final.status, JSON.stringify(final)).toBe("completed");
    expect(final.deliveries).toHaveLength(1);
    expect(final.deliveries[0]!.reviews.at(-1)?.verdict).toBe("approved");
    expect(final.tasks.filter(task => task.role === "planning")).toHaveLength(1);
    expect(final.tasks.length).toBeLessThanOrEqual(12);
    const parents = final.tasks.filter(task => task.sessionKey === key);
    expect(parents.every(task => task.nativeSessionId === prepared.params.initiator.resumeSessionId)).toBe(true);
    expect(final.tasks.every(task => task.status === "succeeded" && task.nativeSessionId)).toBe(true);
    const restored = new ResearchDraftService(join(data.root, "drafts"), data.service, data.execution, data.agents);
    expect((await restored.confirm(edited.id, edited.revision)).id).toBe(run.id);
    expect(await data.repository.list()).toHaveLength(1);
    expect(await readdir(project)).toEqual(["review-context.md"]);
    expect(await readFile(join(project, "review-context.md"), "utf8")).toBe(content);
    if (process.env.HCODE_NATIVE_EVIDENCE_DIR) {
      const evidence = process.env.HCODE_NATIVE_EVIDENCE_DIR;
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, `u0-${agent}-acceptance.json`), JSON.stringify({ prepared, edited, final, sourceHash: createHash("sha256").update(content).digest("hex"), unchanged: true }, null, 2));
      await cp(join(data.root, "drafts"), join(evidence, `drafts-${agent}`), { recursive: true });
    }
  } finally { drafts.dispose(); await data.cleanup(); }
}, 480_000);
