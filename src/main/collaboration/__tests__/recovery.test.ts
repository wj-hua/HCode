// 真实文件系统验证显式尾行恢复；中间损坏/跳号不能被自动抹掉。
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, appendFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CollaborationSnapshot } from "../../../shared/collaboration.js";
import { CollaborationRepository } from "../collaborationRepository.js";

it("一个坏 Run 不遮蔽其他记录，用户修复半截尾行前保留错误与备份", async () => {
  const root = await mkdtemp(join(tmpdir(), "hcode-recovery-"));
  const repository = new CollaborationRepository(root);
  const snapshot: CollaborationSnapshot = { id: randomUUID(), seq: 1, createdAt: Date.now(), status: "running", stage: "planning", tasks: [], deliveries: [], params: { initiator: { agent: "claude", sessionKey: randomUUID(), projectPath: root, permissionMode: "default" }, executor: { agent: "codex" }, objective: "只读" } };
  try {
    await repository.save(snapshot);
    const healthy = { ...snapshot, id: randomUUID() };
    await repository.save(healthy);
    await appendFile(join(root, snapshot.id, "events.jsonl"), '{"seq":2');
    const catalog = await repository.catalog();
    expect(catalog.snapshots.map((run) => run.id)).toEqual([healthy.id]);
    expect(catalog.issues).toEqual([expect.objectContaining({ runId: snapshot.id, canRepairTail: true })]);
    await expect(repository.load(snapshot.id)).rejects.toThrow("尾行");
    expect((await repository.repairTail(snapshot.id)).seq).toBe(1);
    expect((await readdir(join(root, snapshot.id))).some((file) => file.startsWith("events-damaged-"))).toBe(true);
    expect((await repository.catalog()).issues).toHaveLength(0);
    await writeFile(join(root, snapshot.id, "events.jsonl"), `${JSON.stringify({ ...snapshot, seq: 2 })}\nBROKEN\n`);
    await expect(repository.repairTail(snapshot.id)).rejects.toThrow();
    expect((await repository.catalog()).issues[0]?.canRepairTail).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
