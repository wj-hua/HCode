// 可选真实验收：七类本机组合注入、资源读取、专项互审和原会话汇总；先保留无 Skill 基线。
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFile, cp } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { nativeFixture, selectGeminiModel } from "./nativeFixture.js";
import {
  PROFILE_RESEARCH_FILES,
  PROFILE_RESEARCH_OBJECTIVE,
  writeProfileResearchFixture,
} from "./profileResearchFixture.js";
import { BUSINESS_EXPERT_TYPES } from "../../../shared/expertProfiles.js";
import type { CollaborationBackend } from "../../../shared/collaboration.js";
it.skipIf(process.env.HCODE_NATIVE_EXPERT_PROFILES !== "1")(
  "真实七类复合专家及无 Skill 基线闭环",
  async () => {
    const fixture = await nativeFixture(
        "hcode-native-s3b-",
        undefined,
        undefined,
        undefined,
        true,
      ),
      project = join(fixture.root, "project"),
      key = randomUUID();
    await mkdir(project);
    await writeProfileResearchFixture(project);
    try {
      const catalog = await fixture.service.profiles.catalog(project);
      expect(catalog).toHaveLength(7);
      expect(
        catalog.flatMap((profile) => profile.issues),
        JSON.stringify(catalog),
      ).toEqual([]);
      const initiator = {
        agent: "codex" as const,
        sessionKey: key,
        projectPath: project,
        permissionMode: "default" as const,
      };
      const baseline = await fixture.service.startExperts({
        mode: "experts",
        initiator,
        objective: PROFILE_RESEARCH_OBJECTIVE,
        experts: [
          { role: "implementation", backend: { agent: "codex" } },
          { role: "quality", backend: { agent: "claude" } },
        ],
      });
      await vi.waitFor(() => expect(fixture.latest()?.stage).toBe("finished"), {
        timeout: 15 * 60 * 1000,
        interval: 1000,
      });
      const before = await fixture.service.get(baseline.id);
      expect(before.status, JSON.stringify(before)).toBe("completed");
      const model = await selectGeminiModel(fixture.agents);
      const backends: Record<string, CollaborationBackend> = {
        ios: { agent: "claude" },
        android: { agent: "codex" },
        frontend: { agent: "codex" },
        java: { agent: "claude" },
        requirements: { agent: "agy", model },
        design: { agent: "claude" },
        testing: { agent: "codex" },
      };
      const sourceId = before.tasks.find(
        (task) => task.role === "planning",
      )!.nativeSessionId!;
      const run = await fixture.service.startExperts({
        mode: "experts",
        initiator: { ...initiator, resumeSessionId: sourceId },
        objective: PROFILE_RESEARCH_OBJECTIVE,
        turnLimit: 24,
        acceptProfileLimitations: true,
        experts: BUSINESS_EXPERT_TYPES.map((role) => ({
          role,
          backend: backends[role]!,
          profileHash: catalog.find((profile) => profile.role === role)!.hash,
        })),
      });
      await vi.waitFor(() => expect(fixture.latest()?.stage).toBe("finished"), {
        timeout: 28 * 60 * 1000,
        interval: 1000,
      });
      const result = await fixture.service.get(run.id);
      expect(result.status, JSON.stringify(result)).toBe("completed");
      expect(result.tasks.length).toBeLessThanOrEqual(24);
      expect(result.experts!.participants).toHaveLength(7);
      expect(
        result.experts!.reviews.filter(
          (review) => review.status === "completed",
        ),
      ).toHaveLength(7);
      for (const expert of result.experts!.participants) {
        expect(expert.versions.length).toBeGreaterThan(0);
        expect(
          expert.profileLoads?.some((load) => load.stage === "research"),
        ).toBe(true);
        await fixture.service.profiles.packet(run.id, expert.profile!);
      }
      expect(
        result.experts!.participants.find((expert) => expert.role === "ios")!
          .resourceReads!.length,
      ).toBeGreaterThan(0);
      expect(
        result.tasks
          .filter((task) => ["planning", "synthesis"].includes(task.role))
          .every((task) => task.nativeSessionId === sourceId),
      ).toBe(true);
      for (const [path, text] of Object.entries(PROFILE_RESEARCH_FILES))
        expect(await readFile(join(project, path), "utf8")).toBe(text);
      expect(
        (await fixture.repository.load(run.id)).experts!.participants.map(
          (expert) => expert.profile,
        ),
      ).toEqual(result.experts!.participants.map((expert) => expert.profile));
      if (process.env.HCODE_NATIVE_EVIDENCE_DIR) {
        await mkdir(process.env.HCODE_NATIVE_EVIDENCE_DIR, { recursive: true });
        await cp(
          project,
          join(process.env.HCODE_NATIVE_EVIDENCE_DIR, "project"),
          { recursive: true },
        );
      }
    } finally {
      await fixture.cleanup();
    }
  },
  45 * 60 * 1000,
);
