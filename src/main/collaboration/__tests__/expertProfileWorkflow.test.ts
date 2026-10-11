// 七类复合专家通过公开服务运行；真实本机文件边界仅替换外部模型传输。
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentKind } from "../../../shared/types.js";
import type { CollaborationSnapshot } from "../../../shared/collaboration.js";
import type { AgentProvider } from "../../agents/types.js";
import { AgentRegistry } from "../../agents/registry.js";
import { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import { CollaborationRepository } from "../collaborationRepository.js";
import { CollaborationService } from "../collaborationService.js";
import { ExpertProfileService } from "../experts/profiles/expertProfileService.js";
import { PROFILE_DEFINITIONS } from "../experts/profiles/profileDefinitions.js";
import { BUSINESS_EXPERT_TYPES } from "../../../shared/expertProfiles.js";

it.each(["complete", "budget", "corrupt"] as const)(
  "七类专家固定预算、配置加载及专项互审：%s",
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "hcode-profile-workflow-")),
      project = join(root, "project");
    await mkdir(project);
    await writeFile(join(project, "source.ts"), "export const answer = 42;\n");
    for (const name of new Set(
      Object.values(PROFILE_DEFINITIONS).flatMap(
        (definition) => definition.roles,
      ),
    )) {
      const folder = join(root, ".codex/agents");
      await mkdir(folder, { recursive: true });
      await writeFile(
        join(folder, `${name}.toml`),
        `name = "${name}"\ndeveloper_instructions = "Analyze ${name} responsibilities."\n`,
      );
    }
    for (const name of new Set(
      Object.values(PROFILE_DEFINITIONS).flatMap(
        (definition) => definition.skills,
      ),
    )) {
      const folder = join(root, ".codex/skills", name);
      await mkdir(join(folder, "references"), { recursive: true });
      await writeFile(
        join(folder, "SKILL.md"),
        `---\nname: ${name}\n---\nUse ${name} method. Read references/method.md.\n`,
      );
      await writeFile(
        join(folder, "references/method.md"),
        `${name} frozen method`,
      );
    }
    const repository = new CollaborationRepository(join(root, "records")),
      profiles = new ExpertProfileService(repository.root, { home: root });
    const agents = new AgentRegistry(
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
                    : "fixture",
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
    let latest: CollaborationSnapshot | undefined,
      failedOnce = false;
    const sourceKey = randomUUID(),
      sourceId = "native-source";
    const execution = new SessionExecutionService({
      prepare: async (input) => input,
      interrupt: async () => {},
      failedToSend: () => {},
      finishedSending: () => {},
      send: async (input) => {
        const task = latest!.tasks.findLast(
          (entry) => entry.sessionKey === input.sessionKey,
        )!;
        let text = "主持开始";
        if (task.role === "execution") {
          const expert = latest!.experts!.participants.find(
            (entry) => entry.id === task.expertId,
          )!;
          expect(input.text).toContain(
            `Analyze ${expert.profile!.roles[0]!.name}`,
          );
          const resource = expert.profile!.resources[0]!;
          const tool = input.research!.tools!.find(
            (entry) => entry.name === "read_expert_resource",
          )!;
          expect(
            await tool.execute({ skill: resource.skill, path: resource.name }),
          ).toMatchObject({ hash: resource.hash });
          text = JSON.stringify({
            summary: "角色研究",
            findings: [
              {
                id: "answer",
                title: "值",
                detail: "源码为42",
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
            limitations: ["只读，未执行测试"],
          });
          if (scenario === "budget" && !failedOnce) {
            failedOnce = true;
            text = "invalid JSON";
          }
        }
        if (task.role === "review") {
          const review = latest!.experts!.reviews.find(
            (entry) => entry.sessionKey === input.sessionKey,
          )!;
          const expert = latest!.experts!.participants.find(
            (entry) => entry.id === review.reviewerId,
          )!;
          expect(input.text).toContain(
            `Analyze ${expert.profile!.roles[0]!.name}`,
          );
          expect(
            latest!.experts!.participants.every(
              (entry) => entry.versions.length,
            ),
          ).toBe(true);
          text = JSON.stringify({
            summary: "专项核对",
            claims: [
              {
                claimId: "answer",
                assessment: "supported",
                reason: "源码支持",
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
        if (task.role === "synthesis") {
          expect(input.resumeSessionId).toBe(sourceId);
          text = JSON.stringify({
            summary: "七类专家闭环",
            consensus: [
              {
                statement: "经互审支持",
                sources: latest!.experts!.participants.map((entry) => ({
                  expertId: entry.id,
                  versionId: entry.versions.at(-1)!.id,
                  claimId: "answer",
                })),
              },
            ],
            disagreements: [],
            unverified: [],
            limitations: ["未运行设备/网络/市场验证"],
            failedExperts: [],
          });
        }
        execution.acceptOutcome({
          sessionKey: input.sessionKey,
          agent: input.agent,
          executionTurnId: input.executionTurnId!,
          nativeSessionId:
            input.sessionKey === sourceKey
              ? sourceId
              : `native-${input.sessionKey}`,
          outcome: "succeeded",
          text,
        });
        return { sessionKey: input.sessionKey };
      },
    });
    const service = new CollaborationService(
      repository,
      execution,
      agents,
      (snapshot) => {
        latest = snapshot;
      },
      "darwin",
      profiles,
    );
    try {
      const catalog = await profiles.catalog(project);
      expect(catalog.flatMap((entry) => entry.issues)).toEqual([]);
      const run = await service.startExperts({
        mode: "experts",
        initiator: {
          agent: "codex",
          sessionKey: sourceKey,
          projectPath: project,
          permissionMode: "default",
        },
        objective: "源码只读研究",
        turnLimit: scenario === "corrupt" ? 24 : 16,
        acceptProfileLimitations: true,
        experts: BUSINESS_EXPERT_TYPES.map((role) => ({
          role,
          profileHash: catalog.find((entry) => entry.role === role)!.hash,
          backend: { agent: "codex" },
        })),
      });
      await vi.waitFor(() => expect(latest?.stage).toBe("finished"));
      const result = await service.get(run.id);
      expect(result.tasks.length).toBeLessThanOrEqual(16);
      expect(result.status, JSON.stringify(result)).toBe(
        scenario === "budget" ? "awaitingUser" : "completed",
      );
      if (scenario === "budget") {
        expect(result.experts!.summary).toBeUndefined();
        return;
      }
      expect(result.tasks).toHaveLength(16);
      expect(result.experts!.reviews).toHaveLength(7);
      expect(
        result.experts!.reviews.every(
          (review) =>
            review.status === "completed" &&
            review.assignment === "domain" &&
            review.targetId !== review.reviewerId,
        ),
      ).toBe(true);
      expect(
        new Set(result.experts!.reviews.map((review) => review.reviewerId))
          .size,
      ).toBeLessThan(7);
      expect(
        result.experts!.participants.every(
          (expert) =>
            expert.profileLoads!.some((load) => load.stage === "research") &&
            expert.resourceReads!.length > 0,
        ),
      ).toBe(true);
      expect((await repository.load(run.id)).experts).toEqual(result.experts);
      if (scenario === "corrupt") {
        const hash = result.experts!.participants[0]!.profile!.roles[0]!.hash;
        await writeFile(
          join(
            repository.root,
            run.id,
            "artifacts/expert-profiles",
            `${hash}.txt`,
          ),
          "corrupted frozen role",
        );
        await expect(
          service.expertControls.resume(run.id, { action: "review" }),
        ).rejects.toThrow("hash");
        const invalidated = await service.get(run.id);
        expect(invalidated.status).toBe("awaitingUser");
        expect(invalidated.experts!.summary).toBeUndefined();
        expect(invalidated.summary).toBeUndefined();
        expect(invalidated.tasks).toHaveLength(16);
      }
    } finally {
      service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
