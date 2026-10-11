// 对真实持久化失败 Run 通过公开续跑入口验收；原配置、报告、预算与会话身份不改写。
import { readFile, mkdir, cp, realpath } from "node:fs/promises";
import { dirname, join, basename, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import type { CollaborationSnapshot } from "../../../shared/collaboration.js";
import { nativeFixture } from "./nativeFixture.js";
import { PROFILE_RESEARCH_FILES } from "./profileResearchFixture.js";
it.skipIf(
  !process.env.HCODE_NATIVE_EXPERT_PROFILE_RUN ||
    !process.env.HCODE_NATIVE_EVIDENCE_DIR,
)(
  "真实七专家保留报告后续研、互审及同原会话汇总",
  async () => {
    const archive = process.env.HCODE_NATIVE_EVIDENCE_DIR!,
      id = process.env.HCODE_NATIVE_EXPERT_PROFILE_RUN!;
    const previous = JSON.parse(
      await readFile(join(archive, id, "run.json"), "utf8"),
    ) as CollaborationSnapshot;
    const project = previous.params.initiator.projectPath,
      root = dirname(project),
      offset = relative(await realpath(tmpdir()), root);
    if (
      !basename(root).startsWith("hcode-native-s3b-") ||
      offset.startsWith("..") ||
      isAbsolute(offset)
    )
      throw new Error("只能恢复自有原生验收临时目录");
    await mkdir(root, { recursive: true });
    await cp(
      "/Users/geraldgan/Documents/Codex/2026-10-11/hcode-s3b-ui-fixture",
      project,
      { recursive: true },
    );
    await cp(join(archive, id), join(root, "records", id), { recursive: true });
    const fixture = await nativeFixture(
      "hcode-native-s3b-recovery",
      undefined,
      undefined,
      root,
      true,
    );
    try {
      const loaded = await fixture.service.get(id),
        failed = loaded.experts!.participants.filter(
          (expert) => expert.status === "failed",
        );
      expect(failed.map((expert) => expert.role)).toEqual(["requirements"]);
      const versions = loaded
        .experts!.participants.filter((expert) => expert.status === "reported")
        .map((expert) => expert.versions.at(-1)!.hash);
      const sourceId = loaded.params.initiator.resumeSessionId;
      await fixture.service.expertControls.resume(id, {
        action: "research",
        expertId: failed[0]!.id,
      });
      await vi.waitFor(() => expect(fixture.latest()?.stage).toBe("finished"), {
        timeout: 25 * 60 * 1000,
        interval: 1000,
      });
      const result = await fixture.service.get(id);
      expect(result.status, JSON.stringify(result)).toBe("completed");
      expect(result.tasks.length).toBeLessThanOrEqual(24);
      expect(result.experts!.participants).toHaveLength(7);
      expect(
        result.experts!.reviews.filter(
          (review) => review.status === "completed",
        ),
      ).toHaveLength(7);
      expect(
        result
          .experts!.participants.filter(
            (expert) => expert.role !== "requirements",
          )
          .map((expert) => expert.versions.at(-1)!.hash),
      ).toEqual(versions);
      for (const expert of result.experts!.participants) {
        expect(expert.versions.length).toBeGreaterThan(0);
        expect(
          expert.profileLoads?.some((load) => load.stage === "research"),
        ).toBe(true);
        await fixture.service.profiles.packet(id, expert.profile!);
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
        (await fixture.repository.load(id)).experts!.participants.map(
          (expert) => expert.profile,
        ),
      ).toEqual(result.experts!.participants.map((expert) => expert.profile));
      await cp(project, join(archive, "project"), { recursive: true });
    } finally {
      await fixture.cleanup();
    }
  },
  30 * 60 * 1000,
);
