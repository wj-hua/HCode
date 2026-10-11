// 用真实仓库/文件与脚本化外部模型结果验证交付门槛，不 mock 业务规则或证据校验。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DeliverySnapshot } from "../../../shared/collaboration.js";
import { CollaborationRepository } from "../collaborationRepository.js";
import { DeliveryWorkflow } from "../deliveryWorkflow.js";

const report = (detail: string) => JSON.stringify({ summary: detail, findings: [{ id: "finding", title: "状态", detail, evidence: [{ path: "source.ts", startLine: 1, endLine: 1, quote: "export const answer = 42;" }] }], limitations: [] });
const approved = JSON.stringify({ verdict: "approved", summary: "证据与目标一致", issues: [] });
const changes = JSON.stringify({ verdict: "changesRequested", summary: "需补充边界", issues: [{ id: "issue-1", blocking: true, location: "finding", reason: "遗漏边界", evidence: "报告只讨论正常情况", suggestion: "补充失败行为" }] });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hcode-delivery-"));
  const runId = randomUUID();
  await writeFile(join(root, "source.ts"), "export const answer = 42;\n");
  const repository = new CollaborationRepository(join(root, "runs"));
  const delivery: DeliverySnapshot = { id: randomUUID(), requestKey: "request", objective: "核对状态和边界", executor: { agent: "codex" }, status: "queued", versions: [], reviews: [] };
  return { root, runId, repository, delivery };
}

describe("只读委派交付", () => {
  it("阻塞意见经过修订和重新审查后交付新版本", async () => {
    const data = await fixture();
    const results = [report("正常行为"), changes, report("正常与失败行为"), approved];
    try {
      const workflow = new DeliveryWorkflow({ ...data, changed: async () => {}, execute: async (_role, key) => ({ sessionKey: key, agent: "codex", executionTurnId: randomUUID(), outcome: "succeeded", text: results.shift()! }) });
      await workflow.run(data.delivery, randomUUID());
      expect(data.delivery.status).toBe("accepted");
      expect(data.delivery.versions).toHaveLength(2);
      expect(data.delivery.reviews.map((review) => [review.versionId, review.verdict])).toEqual([[data.delivery.versions[0]!.id, "changesRequested"], [data.delivery.versions[1]!.id, "approved"]]);
      expect((await data.repository.readReport(data.runId, data.delivery.versions[1]!)).markdown).toContain("正常与失败行为");
    } finally { await rm(data.root, { recursive: true, force: true }); }
  });

  it("审查期间产物被修改，旧通过结论不能接受交付", async () => {
    const data = await fixture();
    try {
      const workflow = new DeliveryWorkflow({ ...data, changed: async () => {}, execute: async (role, key) => {
        if (role === "review") await writeFile(join(data.root, "runs", data.runId, "artifacts", `${data.delivery.versions[0]!.id}.json`), report("被外部修改"));
        return { sessionKey: key, agent: "codex", executionTurnId: randomUUID(), outcome: "succeeded", text: role === "review" ? approved : report("原报告") };
      } });
      await workflow.run(data.delivery, randomUUID());
      expect(data.delivery.status).toBe("awaitingUser");
      expect(data.delivery.error).toContain("变化");
    } finally { await rm(data.root, { recursive: true, force: true }); }
  });

  it("达到修订上限保留三个版本和阻塞意见，不能假成功", async () => {
    const data = await fixture();
    try {
      const workflow = new DeliveryWorkflow({ ...data, changed: async () => {}, execute: async (role, key) => ({ sessionKey: key, agent: "codex", executionTurnId: randomUUID(), outcome: "succeeded", text: role === "review" ? changes : report("未解决") }) });
      await workflow.run(data.delivery, randomUUID());
      expect(data.delivery.status).toBe("awaitingUser");
      expect(data.delivery.versions).toHaveLength(3);
      expect(data.delivery.reviews).toHaveLength(3);
      expect(data.delivery.error).toContain("上限");
    } finally { await rm(data.root, { recursive: true, force: true }); }
  });

  it("真实执行失败不进入审查或创建空产物", async () => {
    const data = await fixture();
    try {
      const workflow = new DeliveryWorkflow({ ...data, changed: async () => {}, execute: async (_role, key) => ({ sessionKey: key, agent: "codex", executionTurnId: randomUUID(), outcome: "failed", text: "", error: "quota exceeded" }) });
      await workflow.run(data.delivery, randomUUID());
      expect(data.delivery).toMatchObject({ status: "failed", versions: [], reviews: [], error: "quota exceeded" });
    } finally { await rm(data.root, { recursive: true, force: true }); }
  });
});
