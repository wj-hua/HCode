// S5b 原生模型交付后，由用户接口完成预览、冲突拒绝与采纳，再运行原项目公开测试。
import { mkdir, writeFile, readFile, cp, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("../../util/trash.js", () => ({
  trashPaths: async () => {
    throw new Error("禁止删除原生会话");
  },
}));
import { nativeFixture } from "./nativeFixture.js";
import { manifest } from "../workspaces/fileManifest.js";
import { tmpdir } from "node:os";
const exec = promisify(execFile);
it.skipIf(process.env.HCODE_NATIVE_ADOPTION !== "1")(
  "真实 Codex 会话委派 Claude，阻塞修订复审后预览、拒绝冲突、安全采纳并验证原项目",
  async () => {
    let first = true;
    const recovery = process.env.HCODE_NATIVE_ADOPTION_RECOVERY;
    let restoredRoot: string | undefined;
    if (recovery) {
      const archive = join(
        "/Users/geraldgan/Documents/Codex/2026-10-11/hcode-native-s5b",
        recovery,
      );
      const saved = JSON.parse(
        await readFile(join(archive, "run.json"), "utf8"),
      );
      restoredRoot = dirname(saved.params.initiator.projectPath);
      const temporary = await realpath(tmpdir());
      if (
        !restoredRoot!.startsWith(`${temporary}/hcode-s5b-native-`) ||
        dirname(restoredRoot!) !== temporary
      )
        throw new Error("恢复仅限此验收自己的临时目录");
      await mkdir(join(restoredRoot!, "records"), { recursive: true });
      await cp(archive, join(restoredRoot!, "records", recovery), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await cp(
        join(archive, "workspace/baseline"),
        join(restoredRoot!, "project"),
        { recursive: true, errorOnExist: true, force: false },
      );
    }
    const data = await nativeFixture(
      "hcode-s5b-native-",
      (input) => {
        if (input.agent === "claude" && first) {
          first = false;
          return {
            ...input,
            text: "你是隔离代码执行者。只用宿主 read_file/list_files/write_file/delete_file，不运行命令、不修改原项目。初版只为 divide.mjs 添加 value > 0 && divisor === 0 时抛 RangeError，其他保持原行为；保留现有测试，加正数除零测试。独立审查会给完整目标，随后修订。write_file 必须使用 read_file 返回 hash，新文件 null。重新读取最终源码后输出 schema 报告。每条证据只能引用一条完整原始源码行，startLine 必须等于 endLine；保留原始空格，禁止将多行拼为一行。引用 return 或 throw 那条独立行即可。不编造测试结果。",
          };
        }
        return input;
      },
      undefined,
      restoredRoot,
    );
    try {
      const project = join(data.root, "project");
      if (!recovery) {
        await mkdir(project);
        await writeFile(
          join(project, "package.json"),
          '{"name":"hcode-s5b-fixture","private":true,"type":"module"}',
        );
        await writeFile(
          join(project, "divide.mjs"),
          "export function divide(value, divisor) {\n  return value / divisor;\n}\n",
        );
        await writeFile(
          join(project, "divide.test.mjs"),
          "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { divide } from './divide.mjs';\ntest('normal division',()=>{assert.equal(divide(8,2),4);assert.equal(divide(-6,3),-2);});\n",
        );
        await exec("/usr/bin/git", ["init", project]);
        await exec("/usr/bin/git", ["-C", project, "add", "."]);
        await exec("/usr/bin/git", [
          "-c",
          "user.name=HCode test",
          "-c",
          "user.email=test@invalid.local",
          "-c",
          "commit.gpgsign=false",
          "-C",
          project,
          "commit",
          "-m",
          "fixture baseline",
        ]);
        await writeFile(join(project, "untracked.txt"), "retain user context");
      }
      const original = await manifest(project),
        admission = recovery
          ? (await data.service.get(recovery)).code!.workspace.admission
          : await data.service.inspectCodeProject(project);
      const start = recovery
        ? await data.service.get(recovery)
        : await data.service.start({
            initiator: {
              agent: "codex",
              sessionKey: randomUUID(),
              projectPath: project,
              permissionMode: "default",
            },
            executor: { agent: "claude", model: "sonnet" },
            objective:
              "委派一个完整代码任务：divide.mjs 对任何 divisor === 0（包括 0/0、负数除以零和 -0）抛 RangeError，正常及负数除法保持正确，保留现有测试并增加完整边界测试。漏掉 0/0 或完整边界测试是阻塞问题。只生成隔离候选，真实检查与独立审查后由当前会话汇总，原项目由用户另行采纳。",
            code: { admissionHash: admission.hash, checks: ["node-test"] },
          });
      if (recovery)
        await data.service.controls.resume(start.id, {
          action: "execute",
          deliveryId: start.deliveries[0]!.id,
          context:
            "原报告多行引用丢失换行，宿主已拒绝。只引用实际读取到的一条完整原始源码行，startLine=endLine；不能降低证据校验或假称通过。继续实现、检查、独立审查与修订闭环。",
        });
      await vi.waitFor(() => expect(data.latest()?.stage).toBe("finished"), {
        timeout: 660_000,
        interval: 1000,
      });
      const result = await data.service.get(start.id),
        code = result.code!,
        delivery = result.deliveries[0]!;
      expect(result.status, JSON.stringify(result)).toBe("completed");
      expect(delivery.reviews[0]?.verdict).toBe("changesRequested");
      expect(delivery.reviews.at(-1)?.verdict).toBe("approved");
      expect(code.versions.length).toBeGreaterThanOrEqual(2);
      expect(code.validations.at(-1)?.status).toBe("passed");
      expect((await manifest(project)).hash).toBe(original.hash);
      const version = code.versions.at(-1)!,
        preview = await data.service.adoptionPreview(start.id, version.id);
      expect(preview.eligible, JSON.stringify(preview)).toBe(true);
      await writeFile(
        join(project, "divide.mjs"),
        "// user edit after preview\n",
      );
      const conflict = await data.service.adoptionPreview(start.id, version.id);
      expect(conflict.conflicts.map((entry) => entry.path)).toContain(
        "divide.mjs",
      );
      await expect(
        data.service.applyCandidate(start.id, {
          versionId: version.id,
          previewHash: preview.hash,
        }),
      ).rejects.toThrow(/偏离/);
      expect(await readFile(join(project, "divide.mjs"), "utf8")).toBe(
        "// user edit after preview\n",
      );
      await writeFile(
        join(project, "divide.mjs"),
        preview.changes.find((change) => change.path === "divide.mjs")!.before!,
      );
      await writeFile(
        join(project, "untracked.txt"),
        "later unrelated user edit",
      );
      const ready = await data.service.adoptionPreview(start.id, version.id);
      expect(ready.eligible).toBe(true);
      const applied = await data.service.applyCandidate(start.id, {
        versionId: version.id,
        previewHash: ready.hash,
      });
      expect(applied.status, JSON.stringify(applied)).toBe("applied");
      expect(applied.cleanupPending).toBe(false);
      for (const change of ready.changes)
        if (change.after !== null)
          expect(await readFile(join(project, change.path), "utf8")).toBe(
            change.after,
          );
      expect(await readFile(join(project, "untracked.txt"), "utf8")).toBe(
        "later unrelated user edit",
      );
      const check = await exec(process.execPath, ["--test"], { cwd: project });
      expect(check.stdout).toContain("fail 0");
      const outcomes = data.outcomes.length;
      expect(
        await data.service.applyCandidate(start.id, {
          versionId: version.id,
          previewHash: ready.hash,
        }),
      ).toEqual(applied);
      expect(
        (await data.repository.load(start.id)).code!.adoption?.status,
      ).toBe("applied");
      expect(data.outcomes.length).toBe(outcomes);
      expect(
        result.tasks
          .filter(
            (task) => task.role === "planning" || task.role === "synthesis",
          )
          .every((task) => task.agent === "codex"),
      ).toBe(true);
      expect(
        new Set(
          result.tasks
            .filter(
              (task) => task.role === "planning" || task.role === "synthesis",
            )
            .map((task) => task.nativeSessionId),
        ).size,
      ).toBe(1);
      const archive = process.env.HCODE_NATIVE_EVIDENCE_DIR;
      if (archive) {
        await mkdir(archive, { recursive: true });
        await cp(project, join(archive, "project"), { recursive: true });
        await writeFile(
          join(archive, `${start.id}-adoption-verification.json`),
          JSON.stringify(
            {
              original,
              preview,
              conflict,
              ready,
              applied,
              postApplyManifest: await manifest(project),
              nodeTest: check.stdout,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await data.cleanup();
    }
  },
  720_000,
);
