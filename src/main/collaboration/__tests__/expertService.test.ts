// 通过公开服务验证专家阶段屏障、证据、互审与汇总；仅替换外部模型传输。
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import type { AgentKind } from "../../../shared/types.js";
import type { AgentProvider, AgentSendParams } from "../../agents/types.js";
import { AgentRegistry } from "../../agents/registry.js";
import { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import { CollaborationRepository } from "../collaborationRepository.js";
import { CollaborationService } from "../collaborationService.js";
import { EXPERT_LIMITS } from "../../../shared/experts.js";

it.each([
  "complete",
  "partial",
  "invalidPeer",
  "falseConsensus",
  "changedSource",
  "disagreement",
  "invalidVersion",
  "changedDuringSummary",
  "restart",
  "pause",
  "cancel",
  "budget",
  "targetedContext",
  "updatedContext",
] as const)("专家阶段、证据与恢复策略：%s", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "hcode-experts-")),
    project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "source.ts"), "export const answer = 42;\n");
  const key = randomUUID(),
    agents = new AgentRegistry(
      Object.fromEntries(
        (["claude", "codex", "agy"] as const).map((kind) => [
          kind,
          {
            kind,
            getStatus: async () => ({
              found: true,
              version:
                kind === "codex"
                  ? "0.162.0"
                  : kind === "agy"
                    ? "1.3.3"
                    : "test",
            }),
            listModels: async () => [
              { value: "gemini-fixture", label: "Gemini" },
            ],
            hasSession: () => true,
            endResearch: async () => {},
          },
        ]),
      ) as unknown as Record<AgentKind, AgentProvider>,
    );
  const repository = new CollaborationRepository(join(root, "records"));
  const sourceTurns: AgentSendParams[] = [];
  const researchInputs: AgentSendParams[] = [];
  let researchCount = 0,
    reviewCount = 0;
  let delayed: AgentSendParams | undefined;
  const execution = new SessionExecutionService({
    prepare: async (input) => input,
    interrupt: async (sessionKey) => {
      if (delayed?.sessionKey === sessionKey)
        execution.acceptOutcome({
          sessionKey,
          agent: delayed.agent,
          executionTurnId: delayed.executionTurnId!,
          nativeSessionId: `native-${sessionKey}`,
          outcome: "interrupted",
          text: "",
        });
    },
    failedToSend: () => {},
    finishedSending: () => {},
    send: async (input) => {
      let text: string;
      if (input.sessionKey === key) {
        sourceTurns.push(input);
        if (sourceTurns.length === 1) text = "主持开始";
        else {
          const all = (await input
            .research!.tools!.find((tool) => tool.name === "get_task_result")!
            .execute({ taskId: latest!.experts!.participants[0]!.id })) as {
            participants: { id: string; versions: { id: string }[] }[];
          };
          const refs = all.participants
            .filter((participant) =>
              latest!.experts!.activeIds.includes(participant.id),
            )
            .map((participant) => ({
              expertId: participant.id,
              versionId:
                scenario === "invalidVersion"
                  ? randomUUID()
                  : participant.versions.at(-1)!.id,
              claimId: "answer",
            }));
          if (scenario === "changedDuringSummary")
            await writeFile(
              join(project, "source.ts"),
              "export const answer = 43;\n",
            );
          text = JSON.stringify({
            summary: "实际源码中的值为42",
            consensus:
              scenario === "disagreement"
                ? []
                : [
                    {
                      statement: "三个专家的源码结论均经独立互审支持",
                      sources: refs,
                    },
                  ],
            disagreements:
              scenario === "disagreement"
                ? [{ statement: "分歧保留，需人工核对", sources: refs }]
                : [],
            unverified: [],
            limitations: ["未运行测试"],
            failedExperts: all.participants
              .filter(
                (participant) =>
                  !latest!.experts!.activeIds.includes(participant.id),
              )
              .map((participant) => participant.id),
          });
        }
      } else if (
        latest!.tasks.findLast((task) => task.sessionKey === input.sessionKey)
          ?.role === "execution"
      ) {
        if (input.text.startsWith("你是独立研究专家")) { researchCount++; researchInputs.push(input); }
        expect(input.text).not.toContain("peer-secret");
        expect(
          input.research!.tools?.some(
            (tool) => tool.name === "get_task_result",
          ),
        ).toBeFalsy();
        if (
          (scenario === "pause" || scenario === "cancel") &&
          input.agent === "agy"
        ) {
          delayed = input;
          return { sessionKey: input.sessionKey };
        }
        const quote = "export const answer = 42;";
        text =
          (scenario === "partial" || scenario === "targetedContext" && !input.text.includes("指定专家资料：期望值42")) && input.agent === "agy"
            ? "invalid model output"
            : JSON.stringify({
                summary: `peer-secret-${input.agent}`,
                findings: [
                  {
                    id: "answer",
                    title: "值",
                    detail: "源码导出42",
                    evidence: [
                      { path: "source.ts", startLine: 1, endLine: 1, quote },
                    ],
                  },
                ],
                limitations: ["未运行测试"],
              });
      } else {
        reviewCount++;
        expect(researchCount).toBe(scenario === "targetedContext" || scenario === "updatedContext" && researchCount > 3 ? 4 : 3);
        expect(
          latest!
            .experts!.participants.filter((participant) =>
              latest!.experts!.activeIds.includes(participant.id),
            )
            .every((participant) => participant.versions.length >= 1),
        ).toBe(true);
        if (scenario === "changedSource" && reviewCount === 1)
          await writeFile(
            join(project, "source.ts"),
            "export const answer = 43;\n",
          );
        text = JSON.stringify({
          summary: "已核对目标报告的源码结论",
          claims: [
            {
              claimId: scenario === "invalidPeer" ? "invented" : "answer",
              assessment:
                scenario === "falseConsensus" || scenario === "disagreement"
                  ? "disputed"
                  : "supported",
              reason: "源码直接支持",
              evidence: [
                {
                  path: "source.ts",
                  startLine: 1,
                  endLine: 1,
                  quote: "export const answer = 42;",
                },
              ],
            },
          ],
          limitations: ["未运行测试"],
        });
      }
      if (
        scenario === "budget" &&
        input.sessionKey !== key &&
        latest!.tasks.filter((task) => task.sessionKey === input.sessionKey)
          .length === 1
      )
        text = "invalid format requires correction";
      execution.acceptOutcome({
        sessionKey: input.sessionKey,
        agent: input.agent,
        executionTurnId: input.executionTurnId!,
        nativeSessionId: `native-${input.sessionKey}`,
        outcome: "succeeded",
        text,
      });
      return { sessionKey: input.sessionKey };
    },
  });
  let latest: Awaited<ReturnType<CollaborationService["get"]>> | undefined;
  let checkpoint: typeof latest;
  const service = new CollaborationService(
    repository,
    execution,
    agents,
    (snapshot) => {
      latest = snapshot;
      if (!checkpoint && snapshot.stage === "peerReview")
        checkpoint = structuredClone(snapshot);
    },
    "darwin",
  );
  try {
    const run = await service.startExperts({
      mode: "experts",
      initiator: {
        agent: "codex",
        sessionKey: key,
        projectPath: project,
        permissionMode: "default",
      },
      objective: "只读研究 source.ts 的正常与失败行为",
      ...(scenario === "updatedContext" ? { turnLimit: EXPERT_LIMITS.maxTurns } : {}),
      experts: [
        { role: "architecture", backend: { agent: "claude" } },
        { role: "implementation", backend: { agent: "codex" } },
        { role: "quality", backend: { agent: "agy", model: "gemini-fixture" } },
      ],
    });
    if (scenario === "pause" || scenario === "cancel") {
      await vi.waitFor(() => expect(delayed).toBeDefined());
      await service.controls.stop(
        run.id,
        scenario === "pause" ? "pause" : "cancel",
      );
    }
    await vi.waitFor(() => expect(latest?.stage).toBe("finished"));
    const result = await service.get(run.id);

    if (scenario === "updatedContext") {
      expect(result.status).toBe("completed");
      const target = result.experts!.participants[0]!;
      const others = result.experts!.participants.slice(1);
      const before = researchInputs.length;
      await service.controls.supplement(run.id, target.id, "新资料：只核对实际源码值42，不能冒称产品完整验收");
      const saved = await service.get(run.id);
      expect(saved.status).toBe("awaitingUser");
      expect(saved.summary).toBeUndefined();
      expect(saved.experts!.summary).toBeUndefined();
      expect(saved.experts!.rawSummaries).toEqual(result.experts!.rawSummaries);
      expect(saved.experts!.participants).toEqual(result.experts!.participants);
      expect(researchInputs).toHaveLength(before);
      await service.expertControls.resume(run.id, { action: "research", expertId: target.id });
      await vi.waitFor(() => expect(latest?.status).toBe("completed"));
      const final = await service.get(run.id);
      expect(final.experts!.participants.slice(1)).toEqual(others);
      expect(final.experts!.participants[0]!.versions).toHaveLength(2);
      expect(researchInputs.at(-1)!.text).toContain("新资料：只核对实际源码值42");
      return;
    }

    if (scenario === "targetedContext") {
      expect(result.status).toBe("awaitingUser");
      const target = result.experts!.participants.find(expert => expert.status === "failed")!;
      const others = result.experts!.participants.filter(expert => expert.id !== target.id);
      const before = result.tasks.length;
      await service.controls.supplement(run.id, target.id, "指定专家资料：期望值42，只读核对 source.ts");
      expect((await service.get(run.id)).tasks).toHaveLength(before);
      await service.expertControls.resume(run.id, { action: "research", expertId: target.id });
      await vi.waitFor(() => expect(latest?.stage).toBe("finished"));
      const final = await service.get(run.id);
      expect(final.status, JSON.stringify(final)).toBe("completed");
      expect(researchInputs.filter(input => input.sessionKey !== target.sessionKey)).toHaveLength(2);
      expect(final.experts!.participants.filter(expert => expert.id !== target.id)).toEqual(others);
      expect(researchInputs.at(-1)!.text).toContain("指定专家资料：期望值42");
      return;
    }

    if (scenario === "pause" || scenario === "cancel") {
      expect(result.status).toBe(scenario === "pause" ? "paused" : "cancelled");
      expect(result.experts!.summary).toBeUndefined();
      expect(sourceTurns).toHaveLength(1);
      if (scenario === "cancel") {
        await expect(
          service.expertControls.resume(run.id, { action: "research" }),
        ).rejects.toThrow("取消");
        return;
      }
      await service.expertControls.resume(run.id, {
        action: "continuePartial",
      });
      await vi.waitFor(() => expect(latest?.status).toBe("completed"));
      return;
    }
    if (scenario === "budget") {
      expect(result.status).toBe("awaitingUser");
      expect(result.tasks.length).toBeLessThanOrEqual(12);
      expect(result.tasks.some((task) => task.role === "synthesis")).toBe(
        false,
      );
      expect(
        result.experts!.reviews.some((review) =>
          review.error?.includes("预算"),
        ),
      ).toBe(true);
      return;
    }
    if (scenario === "partial") {
      expect(result.status).toBe("awaitingUser");
      expect(reviewCount).toBe(0);
      expect(sourceTurns).toHaveLength(1);
      expect(
        result.experts!.participants.find(
          (expert) => expert.backend.agent === "agy",
        )!.rawResults,
      ).toHaveLength(2);
      await service.expertControls.resume(run.id, {
        action: "continuePartial",
      });
      await vi.waitFor(() => expect(latest?.status).toBe("completed"));
      const partial = await service.get(run.id);
      expect(partial.experts!.activeIds).toHaveLength(2);
      expect(partial.experts!.partialAuthorized).toBe(true);
      expect(partial.experts!.summary!.failedExperts).toHaveLength(1);
      expect(partial.experts!.participants).toHaveLength(3);
      return;
    }
    if (scenario === "invalidPeer" || scenario === "changedSource") {
      expect(result.status, JSON.stringify(result)).toBe("awaitingUser");
      expect(result.experts!.summary).toBeUndefined();
      expect(sourceTurns).toHaveLength(1);
      expect(
        result.experts!.reviews.some(
          (review) => review.status === "failed" && review.error,
        ),
      ).toBe(true);
      return;
    }
    if (scenario === "invalidVersion" || scenario === "changedDuringSummary") {
      expect(result.status).not.toBe("completed");
      expect(result.summary).toBeUndefined();
      expect(result.experts!.summary).toBeUndefined();
      expect(result.error).toBeTruthy();
      return;
    }
    if (scenario === "falseConsensus") {
      expect(result.status).toBe("failed");
      expect(result.summary).toBeUndefined();
      expect(result.error).toContain("不能列为共识");
      expect(result.experts!.rawSummaries).toHaveLength(2);
      expect(
        result.experts!.reviews.every((review) =>
          review.claims?.every((claim) => claim.assessment === "disputed"),
        ),
      ).toBe(true);
      return;
    }
    expect(result.status, JSON.stringify(result)).toBe("completed");
    expect([researchCount, reviewCount, sourceTurns.length]).toEqual([3, 3, 2]);
    expect(sourceTurns[1]?.resumeSessionId).toBe(`native-${key}`);
    expect(
      result.experts!.reviews.every(
        (review) =>
          review.targetId !== review.reviewerId &&
          review.claims?.every((claim) =>
            claim.evidence.every((evidence) => evidence.hash.length === 64),
          ),
      ),
    ).toBe(true);
    expect(result.experts!.summary?.consensus).toHaveLength(
      scenario === "disagreement" ? 0 : 1,
    );
    if (scenario === "disagreement")
      expect(result.experts!.summary?.disagreements).toHaveLength(1);
    expect(result.deliveries).toEqual([]);
    expect((await repository.load(run.id)).experts).toEqual(result.experts);
    if (scenario === "restart") {
      const restoredRepository = new CollaborationRepository(
        join(root, "restored"),
      );
      await cp(
        join(repository.root, run.id, "artifacts"),
        join(restoredRepository.root, run.id, "artifacts"),
        { recursive: true },
      );
      checkpoint!.seq = 1;
      await restoredRepository.save(checkpoint!);
      const restored = new CollaborationService(
        restoredRepository,
        execution,
        agents,
        (snapshot) => {
          latest = snapshot;
        },
        "darwin",
      );
      try {
        const before = sourceTurns.length;
        expect((await restored.get(run.id)).status).toBe("interrupted");
        expect(sourceTurns).toHaveLength(before);
        await restored.expertControls.resume(run.id, { action: "review" });
        await vi.waitFor(() => expect(latest?.status).toBe("completed"));
        expect(
          (await restored.get(run.id)).experts!.participants.every(
            (expert) => expert.versions.length === 1,
          ),
        ).toBe(true);
        expect(sourceTurns.at(-1)!.resumeSessionId).toBe(`native-${key}`);
      } finally {
        restored.dispose();
      }
    }
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
