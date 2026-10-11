// 可选本机验收：真实三后端独立调研、互审及原 Codex 会话结构化汇总；不伪造模型输出。
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { nativeFixture, selectGeminiModel } from "./nativeFixture.js";

it.skipIf(process.env.HCODE_NATIVE_EXPERTS !== "1")(
  "真实 Claude/Codex/Gemini 专家研究→互审→原会话汇总",
  async () => {
    const fixture = await nativeFixture(
      "hcode-native-s3-experts-",
      undefined,
      undefined,
      undefined,
      true,
    );
    const project = join(fixture.root, "project"),
      key = randomUUID();
    await mkdir(project);
    const source =
      "export function divide(value, divisor) {\n  return value / divisor;\n}\n";
    await writeFile(join(project, "divide.js"), source);
    await writeFile(
      join(project, "divide.test.js"),
      "import { divide } from './divide.js';\nimport { strict as assert } from 'node:assert';\nassert.equal(divide(6, 2), 3);\nassert.throws(() => divide(6, 0), RangeError);\n",
    );
    try {
      const model = await selectGeminiModel(fixture.agents);
      const run = await fixture.service.startExperts({
        mode: "experts",
        initiator: {
          agent: "codex",
          sessionKey: key,
          projectPath: project,
          permissionMode: "default",
        },
        objective:
          "仅阅读 divide.js 和 divide.test.js：从模块职责、JavaScript 实现行为、测试覆盖三个角度分别研究。每位专家给3条有实际完整源码行引用的核心结论，稳定 claimId。区分 Number 除零、BigInt 和混合类型；说明测试文件中的预期与实现是否一致。不要执行测试或联网。互审逐项核对另一位专家的结论，允许有证据的分歧；主持汇总保留所有争议和未验证事项。",
        experts: [
          { role: "architecture", backend: { agent: "claude" } },
          { role: "implementation", backend: { agent: "codex" } },
          { role: "quality", backend: { agent: "agy", model } },
        ],
      });
      await vi.waitFor(() => expect(fixture.latest()?.stage).toBe("finished"), {
        timeout: 25 * 60 * 1000,
        interval: 1000,
      });
      const result = await fixture.service.get(run.id);
      expect(result.status, JSON.stringify(result)).toBe("completed");
      expect(
        result.experts!.participants.every(
          (expert) =>
            expert.status === "reported" && expert.versions.length === 1,
        ),
      ).toBe(true);
      expect(result.experts!.reviews).toHaveLength(3);
      expect(
        result.experts!.reviews.every(
          (review) =>
            review.status === "completed" &&
            review.targetId !== review.reviewerId &&
            review.nativeSessionId,
        ),
      ).toBe(true);
      const sourceTurns = result.tasks.filter(
        (task) => task.sessionKey === key,
      );
      expect(sourceTurns.length).toBeGreaterThanOrEqual(2);
      expect(
        new Set(sourceTurns.map((task) => task.nativeSessionId)).size,
      ).toBe(1);
      expect(result.experts!.summary?.limitations.length).toBeGreaterThan(0);
      expect(result.tasks.length).toBeLessThanOrEqual(12);
      expect((await fixture.repository.load(run.id)).experts?.summary).toEqual(
        result.experts!.summary,
      );
      expect(await readFile(join(project, "divide.js"), "utf8")).toBe(source);
      console.info(
        "S3_NATIVE",
        JSON.stringify({
          runId: run.id,
          sourceId: sourceTurns[0]!.nativeSessionId,
          turns: result.tasks.length,
          experts: result.experts!.participants.map((expert) => ({
            id: expert.id,
            role: expert.role,
            backend: expert.backend,
            version: expert.versions[0]?.id,
          })),
          reviews: result.experts!.reviews.map((review) => ({
            reviewerId: review.reviewerId,
            targetId: review.targetId,
            nativeSessionId: review.nativeSessionId,
            claims: review.claims?.map((claim) => ({
              id: claim.claimId,
              assessment: claim.assessment,
            })),
          })),
          summary: result.experts!.summary,
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  },
  30 * 60 * 1000,
);
