// 通过公开协作接口验证采纳，文件系统、冻结版本和审查记录均走真实边界。
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  chmod,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CollaborationSnapshot } from "../../../shared/collaboration.js";
import { AgentRegistry } from "../../agents/registry.js";
import type { AgentKind } from "../../../shared/types.js";
import type { AgentProvider } from "../../agents/types.js";
import { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import { CollaborationRepository } from "../collaborationRepository.js";
import { CollaborationService } from "../collaborationService.js";
import { CodeAdoptionService } from "../adoption/codeAdoptionService.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
export async function adoptionFixture() {
  const root = await mkdtemp(join(tmpdir(), "hcode-adoption-"));
  roots.push(root);
  const original = join(root, "original");
  await mkdir(original);
  await writeFile(join(original, "source.js"), "old\n");
  await writeFile(join(original, "unrelated.txt"), "retain\n");
  const send = vi.fn(async () => {
    throw new Error("采纳不得启动 CLI");
  });
  const execution = new SessionExecutionService({
    prepare: async (input) => input,
    send,
    interrupt: async () => {},
    failedToSend: () => {},
    finishedSending: () => {},
  });
  const repository = new CollaborationRepository(join(root, "records"));
  const service = new CollaborationService(
    repository,
    execution,
    new AgentRegistry({} as Record<AgentKind, AgentProvider>),
    () => {},
  );
  const id = randomUUID(),
    workspace = await service.workspaces.create(original, id);
  workspace.admission.checks = [
    {
      id: "node-test",
      executable: "/usr/bin/true",
      args: [],
      description: "fixture check",
    },
  ];
  await writeFile(join(workspace.path, "source.js"), "new\n");
  const version = await service.workspaces.freeze(workspace, 1);
  const report = await repository.writeReport(
    id,
    1,
    JSON.stringify({ summary: "候选", findings: [], limitations: [] }),
    [],
  );
  const snapshot: CollaborationSnapshot = {
    id,
    seq: 1,
    createdAt: Date.now(),
    status: "completed",
    stage: "finished",
    summary: "待采纳",
    tasks: [],
    deliveries: [
      {
        id: randomUUID(),
        requestKey: "code",
        objective: "代码交付",
        executor: { agent: "codex" },
        status: "accepted",
        versions: [report],
        reviews: [
          {
            versionId: report.id,
            verdict: "approved",
            summary: "通过",
            issues: [],
          },
        ],
      },
    ],
    params: {
      initiator: {
        agent: "claude",
        sessionKey: randomUUID(),
        projectPath: original,
        permissionMode: "default",
      },
      executor: { agent: "codex" },
      objective: "代码交付",
    },
    code: {
      workspace,
      versions: [version],
      validations: [
        {
          checkId: "node-test",
          command: "fixture check",
          versionId: version.id,
          versionHash: version.hash,
          exitCode: 0,
          status: "passed",
          stdout: "",
          stderr: "",
          logTruncated: false,
        },
      ],
      phase: "candidate",
    },
  };
  await repository.save(snapshot);
  return {
    root,
    service,
    repository,
    snapshot,
    version,
    original,
    send,
    restart: () =>
      new CollaborationService(
        repository,
        execution,
        new AgentRegistry({} as Record<AgentKind, AgentProvider>),
        () => {},
      ),
  };
}
it("预览不写原项目；明确版本和预览 hash 后采纳，重启及重复请求不重复应用", async () => {
  const data = await adoptionFixture();
  const preview = await data.service.adoptionPreview(
    data.snapshot.id,
    data.version.id,
  );
  expect(preview.conflicts).toEqual([]);
  expect(preview.eligible).toBe(true);
  expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
    "old\n",
  );
  const result = await data.service.applyCandidate(data.snapshot.id, {
    versionId: data.version.id,
    previewHash: preview.hash,
  });
  expect(result.status).toBe("applied");
  expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
    "new\n",
  );
  expect(await readFile(join(data.original, "unrelated.txt"), "utf8")).toBe(
    "retain\n",
  );
  expect(
    await data.service.applyCandidate(data.snapshot.id, {
      versionId: data.version.id,
      previewHash: preview.hash,
    }),
  ).toEqual(result);
  expect(
    (await data.restart().get(data.snapshot.id)).code!.adoption?.status,
  ).toBe("applied");
  await expect(
    data.restart().candidateAction(data.snapshot.id, "manual"),
  ).rejects.toThrow(/已应用/);
  await expect(
    data.restart().controls.resume(data.snapshot.id, {
      action: "execute",
      deliveryId: data.snapshot.deliveries[0]!.id,
    }),
  ).rejects.toThrow(/已应用/);
  expect(data.send).not.toHaveBeenCalled();
});
it("所有文件先检查，新增冲突/删除冲突/权限冲突都不写；无关文件改动保留", async () => {
  const data = await adoptionFixture();
  await writeFile(
    join(data.snapshot.code!.workspace.path, "new.txt"),
    "new file",
  );
  await rm(join(data.snapshot.code!.workspace.path, "unrelated.txt"));
  const version = await data.service.workspaces.freeze(
    data.snapshot.code!.workspace,
    2,
  );
  data.snapshot.code!.versions.push(version);
  const report = await data.repository.writeReport(
    data.snapshot.id,
    2,
    JSON.stringify({ summary: "v2", findings: [], limitations: [] }),
    [],
  );
  data.snapshot.deliveries[0]!.versions.push(report);
  data.snapshot.deliveries[0]!.reviews.push({
    versionId: report.id,
    verdict: "approved",
    summary: "approved",
    issues: [],
  });
  data.snapshot.code!.validations.push({
    ...data.snapshot.code!.validations[0]!,
    versionId: version.id,
    versionHash: version.hash,
  });
  data.snapshot.seq++;
  await data.repository.save(data.snapshot);
  const preview = await data.service.adoptionPreview(
    data.snapshot.id,
    version.id,
  );
  await writeFile(join(data.original, "new.txt"), "user file");
  await writeFile(join(data.original, "unrelated.txt"), "user edit");
  const conflict = await data.service.adoptionPreview(
    data.snapshot.id,
    version.id,
  );
  expect(conflict.conflicts.map((c) => c.path)).toEqual([
    "new.txt",
    "unrelated.txt",
  ]);
  await expect(
    data.service.applyCandidate(data.snapshot.id, {
      versionId: version.id,
      previewHash: preview.hash,
    }),
  ).rejects.toThrow(/偏离/);
  expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
    "old\n",
  );
  expect(await readFile(join(data.original, "new.txt"), "utf8")).toBe(
    "user file",
  );
  expect(data.send).not.toHaveBeenCalled();
});
it.each(["review", "validation", "candidate", "oldVersion", "manual"] as const)(
  "阻止不满足采纳条件：%s",
  async (reason) => {
    const data = await adoptionFixture();
    if (reason === "review")
      data.snapshot.deliveries[0]!.reviews[0]!.verdict = "changesRequested";
    if (reason === "validation")
      data.snapshot.code!.validations[0]!.versionHash = "0".repeat(64);
    if (reason === "candidate")
      await writeFile(
        join(data.snapshot.code!.workspace.path, "source.js"),
        "edited",
      );
    if (reason === "oldVersion")
      data.snapshot.code!.versions.push({
        ...data.version,
        id: randomUUID(),
        version: 2,
      });
    if (reason === "manual") data.snapshot.code!.phase = "manual";
    data.snapshot.seq++;
    await data.repository.save(data.snapshot);
    const preview = await data.service.adoptionPreview(
      data.snapshot.id,
      data.version.id,
    );
    expect(preview.eligible).toBe(false);
    await expect(
      data.service.applyCandidate(data.snapshot.id, {
        versionId: data.version.id,
        previewHash: preview.hash,
      }),
    ).rejects.toThrow();
    expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
      "old\n",
    );
  },
);
async function acceptNext(data: Awaited<ReturnType<typeof adoptionFixture>>) {
  const code = data.snapshot.code!,
    version = await data.service.workspaces.freeze(code.workspace, 2);
  code.versions.push(version);
  const report = await data.repository.writeReport(
    data.snapshot.id,
    2,
    JSON.stringify({ summary: "v2", findings: [], limitations: [] }),
    [],
  );
  const delivery = data.snapshot.deliveries[0]!;
  delivery.versions.push(report);
  delivery.reviews.push({
    versionId: report.id,
    verdict: "approved",
    summary: "通过",
    issues: [],
  });
  code.validations.push({
    ...code.validations[0]!,
    versionId: version.id,
    versionHash: version.hash,
  });
  data.snapshot.seq++;
  await data.repository.save(data.snapshot);
  return version;
}
it("应用新增、删除、二进制和权限，保留改动范围外的文件", async () => {
  const data = await adoptionFixture(),
    candidate = data.snapshot.code!.workspace.path;
  await mkdir(join(candidate, "nested"));
  await writeFile(
    join(candidate, "nested/binary.bin"),
    Buffer.from([0, 255, 34]),
  );
  await rm(join(candidate, "unrelated.txt"));
  await chmod(join(candidate, "source.js"), 0o755);
  const version = await acceptNext(data),
    preview = await data.service.adoptionPreview(data.snapshot.id, version.id);
  await writeFile(join(data.original, "later-user.txt"), "keep");
  const applied = await data.service.applyCandidate(data.snapshot.id, {
    versionId: version.id,
    previewHash: preview.hash,
  });
  expect(applied.status).toBe("applied");
  expect(applied.cleanupPending).toBe(false);
  expect(await readFile(join(data.original, "nested/binary.bin"))).toEqual(
    Buffer.from([0, 255, 34]),
  );
  expect((await stat(join(data.original, "source.js"))).mode & 0o777).toBe(
    0o755,
  );
  await expect(
    stat(join(data.original, "unrelated.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(data.original, "later-user.txt"), "utf8")).toBe(
    "keep",
  );
});
it("应用中断后重启只读恢复记录，不自动续写；显式恢复撤回原件", async () => {
  const data = await adoptionFixture();
  const adoption = new CodeAdoptionService(
    data.service.workspaces,
    data.repository,
    async (stage) => {
      if (stage === "afterFile")
        throw new Error("EIO injected after replacement");
    },
  );
  const preview = await adoption.preview(data.snapshot, data.version.id);
  const stopped = await adoption.apply(data.snapshot, {
    versionId: data.version.id,
    previewHash: preview.hash,
  });
  expect(stopped.status).toBe("needsRecovery");
  expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
    "new\n",
  );
  const restart = data.restart();
  expect((await restart.get(data.snapshot.id)).code!.adoption?.id).toBe(
    stopped.id,
  );
  expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
    "new\n",
  );
  await expect(
    restart.candidateAction(data.snapshot.id, "discard"),
  ).rejects.toThrow(/恢复/);
  const restored = await restart.recoverAdoption(data.snapshot.id, stopped.id);
  expect(restored.status).toBe("rolledBack");
  expect(restored.cleanupPending).toBe(false);
  expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
    "old\n",
  );
  expect(
    (await restart.adoptionPreview(data.snapshot.id, data.version.id)).eligible,
  ).toBe(true);
  expect(data.send).not.toHaveBeenCalled();
});
it("恢复遇到后续人工修改时保留修改和日志，不能覆盖成旧基线", async () => {
  const data = await adoptionFixture();
  const adoption = new CodeAdoptionService(
    data.service.workspaces,
    data.repository,
    async (stage) => {
      if (stage === "afterFile") throw new Error("interrupt");
    },
  );
  const preview = await adoption.preview(data.snapshot, data.version.id);
  const stopped = await adoption.apply(data.snapshot, {
    versionId: data.version.id,
    previewHash: preview.hash,
  });
  await writeFile(
    join(data.original, "source.js"),
    "user edited after interrupted apply",
  );
  const restored = await data
    .restart()
    .recoverAdoption(data.snapshot.id, stopped.id);
  expect(restored.status).toBe("needsRecovery");
  expect(restored.error).toContain("后续修改");
  expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
    "user edited after interrupted apply",
  );
});
it("应用开始后再次变更原文件也不覆盖；符号链接祖先和冻结文件污染明确阻止", async () => {
  const data = await adoptionFixture();
  const adoption = new CodeAdoptionService(
    data.service.workspaces,
    data.repository,
    async (stage) => {
      if (stage === "beforeFile")
        await writeFile(join(data.original, "source.js"), "late user edit");
    },
  );
  const preview = await adoption.preview(data.snapshot, data.version.id);
  const stopped = await adoption.apply(data.snapshot, {
    versionId: data.version.id,
    previewHash: preview.hash,
  });
  expect(stopped.status).toBe("needsRecovery");
  expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
    "late user edit",
  );
  expect(
    (await data.restart().recoverAdoption(data.snapshot.id, stopped.id)).status,
  ).toBe("rolledBack");
  const next = await adoptionFixture();
  await mkdir(join(next.snapshot.code!.workspace.path, "nested"));
  await writeFile(
    join(next.snapshot.code!.workspace.path, "nested/new.txt"),
    "new",
  );
  const version = await acceptNext(next);
  await symlink(next.original, join(next.original, "nested"));
  const conflict = await next.service.adoptionPreview(
    next.snapshot.id,
    version.id,
  );
  expect(conflict.eligible).toBe(false);
  expect(conflict.conflicts[0]?.reason).toContain("祖先");
  await writeFile(
    join(
      next.service.workspaces.directory(next.snapshot.id),
      version.id,
      "files/source.js",
    ),
    "tampered",
  );
  await expect(
    next.service.adoptionPreview(next.snapshot.id, version.id),
  ).rejects.toThrow(/冻结/);
});
it("已准备但尚未写入时失败，恢复只清理自己的临时目录", async () => {
  const data = await adoptionFixture();
  const adoption = new CodeAdoptionService(
    data.service.workspaces,
    data.repository,
    async (stage) => {
      if (stage === "prepared") throw new Error("interrupt before files");
    },
  );
  const preview = await adoption.preview(data.snapshot, data.version.id);
  const stopped = await adoption.apply(data.snapshot, {
    versionId: data.version.id,
    previewHash: preview.hash,
  });
  expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
    "old\n",
  );
  expect(
    (await data.restart().recoverAdoption(data.snapshot.id, stopped.id)).status,
  ).toBe("rolledBack");
});
it("真实子进程在替换后 SIGKILL，重启发现 applying 日志并显式恢复，无模型副作用", async () => {
  const data = await adoptionFixture();
  const { build } = await import("tsup");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const directory = join(data.root, "runtime");
  await build({
    entry: ["src/main/collaboration/__tests__/adoptionCrashFixture.ts"],
    outDir: directory,
    format: ["esm"],
    platform: "node",
    target: "node24",
    noExternal: ["zod"],
    config: false,
    silent: true,
  });
  await writeFile(join(data.root, "input.json"), JSON.stringify(data.snapshot));
  await expect(
    promisify(execFile)(process.execPath, [
      join(directory, "adoptionCrashFixture.js"),
      data.root,
    ]),
  ).rejects.toMatchObject({ signal: "SIGKILL" });
  const restart = data.restart(),
    restored = await restart.get(data.snapshot.id);
  expect(restored.code!.adoption?.status).toBe("applying");
  expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
    "new\n",
  );
  expect(
    (
      await restart.recoverAdoption(
        data.snapshot.id,
        restored.code!.adoption!.id,
      )
    ).status,
  ).toBe("rolledBack");
  expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
    "old\n",
  );
  expect(data.send).not.toHaveBeenCalled();
}, 30_000);

it("同原项目另一个采纳被锁阻止，当前候选也不能被接管", async () => {
  const data = await adoptionFixture();
  const secondId = randomUUID();
  const workspace = await data.service.workspaces.create(
    data.original,
    secondId,
    data.snapshot.code!.workspace.admission,
  );
  await writeFile(join(workspace.path, "source.js"), "second candidate\n");
  const version = await data.service.workspaces.freeze(workspace, 1);
  const report = await data.repository.writeReport(
    secondId,
    1,
    JSON.stringify({ summary: "second", findings: [], limitations: [] }),
    [],
  );
  const second = structuredClone(data.snapshot);
  second.id = secondId;
  second.code!.workspace = workspace;
  second.code!.versions = [version];
  second.code!.validations = [
    {
      ...second.code!.validations[0]!,
      versionId: version.id,
      versionHash: version.hash,
    },
  ];
  second.deliveries[0]!.versions = [report];
  second.deliveries[0]!.reviews = [
    {
      versionId: report.id,
      verdict: "approved",
      summary: "approved",
      issues: [],
    },
  ];
  await data.repository.save(second);
  let entered!: () => void, release!: () => void;
  const prepared = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adoption = new CodeAdoptionService(
    data.service.workspaces,
    data.repository,
    async (stage) => {
      if (stage === "prepared") {
        entered();
        await wait;
      }
    },
  );
  const preview = await adoption.preview(data.snapshot, data.version.id);
  const applying = adoption.apply(data.snapshot, {
    versionId: data.version.id,
    previewHash: preview.hash,
  });
  await prepared;
  try {
    const conflict = await data.service.adoptionPreview(secondId, version.id);
    expect(conflict.eligible).toBe(false);
    expect(conflict.reasons.join()).toContain("采纳锁");
    await expect(
      data.service.candidateAction(data.snapshot.id, "manual"),
    ).rejects.toThrow(/恢复|占用|锁定/);
    await expect(
      data.service.applyCandidate(secondId, {
        versionId: version.id,
        previewHash: conflict.hash,
      }),
    ).rejects.toThrow(/采纳锁/);
    expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
      "old\n",
    );
  } finally {
    release();
  }
  expect((await applying).status).toBe("applied");
});
it("成功记录先于清理持久化，未知临时文件只阻止清理，重启不撤销成功采纳", async () => {
  const data = await adoptionFixture();
  const adoption = new CodeAdoptionService(
    data.service.workspaces,
    data.repository,
    async (stage) => {
      if (stage === "beforeCommit")
        await writeFile(
          join(data.original, ".hcode-apply-lock/user-note.txt"),
          "preserve",
        );
    },
  );
  const preview = await adoption.preview(data.snapshot, data.version.id);
  const applied = await adoption.apply(data.snapshot, {
    versionId: data.version.id,
    previewHash: preview.hash,
  });
  expect(applied.status).toBe("applied");
  expect(applied.cleanupPending).toBe(true);
  expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
    "new\n",
  );
  const restart = data.restart();
  expect(
    (await restart.recoverAdoption(data.snapshot.id, applied.id))
      .cleanupPending,
  ).toBe(true);
  expect(
    await readFile(
      join(data.original, ".hcode-apply-lock/user-note.txt"),
      "utf8",
    ),
  ).toBe("preserve");
  await rm(join(data.original, ".hcode-apply-lock/user-note.txt"));
  const cleaned = await restart.recoverAdoption(data.snapshot.id, applied.id);
  expect(cleaned.status).toBe("applied");
  expect(cleaned.cleanupPending).toBe(false);
  expect(await readFile(join(data.original, "source.js"), "utf8")).toBe(
    "new\n",
  );
});

it("恢复不删除被另一个目录替换的同名父目录", async () => {
  const data = await adoptionFixture();
  await mkdir(join(data.snapshot.code!.workspace.path, "nested"));
  await writeFile(
    join(data.snapshot.code!.workspace.path, "nested/new.txt"),
    "new",
  );
  const version = await acceptNext(data);
  const { rename } = await import("node:fs/promises");
  const adoption = new CodeAdoptionService(
    data.service.workspaces,
    data.repository,
    async (stage, _, index) => {
      if (stage === "afterFile" && index === 0) {
        await rename(
          join(data.original, "nested"),
          join(data.original, "moved-by-user"),
        );
        await mkdir(join(data.original, "nested"));
        throw new Error("directory replaced by user");
      }
    },
  );
  const preview = await adoption.preview(data.snapshot, version.id);
  const stopped = await adoption.apply(data.snapshot, {
    versionId: version.id,
    previewHash: preview.hash,
  });
  const recovered = await data
    .restart()
    .recoverAdoption(data.snapshot.id, stopped.id);
  expect((await stat(join(data.original, "nested"))).isDirectory()).toBe(true);
  expect(recovered.status).toBe("needsRecovery");
  expect(
    await readFile(join(data.original, "moved-by-user/new.txt"), "utf8"),
  ).toBe("new");
});
