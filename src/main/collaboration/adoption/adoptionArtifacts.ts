// 采纳只读取经清单、差异与实际字节校验的冻结内容，不从可写副本复制。
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  CodeVersion,
  CodeWorkspace,
} from "../../../shared/codeDelivery.js";
import { hashBytes, type FileManifest } from "../workspaces/fileManifest.js";
import { candidateChanges } from "../workspaces/candidateChanges.js";
import type { WorkspaceService } from "../workspaces/workspaceService.js";
import {
  adoptionEntrySchema,
  adoptionPath,
  type AdoptionJournal,
} from "./adoptionContracts.js";
const manifestSchema = z
  .object({
    hash: z.string(),
    entries: z.array(adoptionEntrySchema.extend({ path: z.string().min(1) })),
    bytes: z.number().nonnegative(),
  })
  .strict();
async function frozenManifest(
  path: string,
  expected: string,
): Promise<FileManifest> {
  const value = manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (
    value.hash !== expected ||
    hashBytes(JSON.stringify(value.entries)) !== expected ||
    new Set(value.entries.map((e) => e.path)).size !== value.entries.length
  )
    throw new Error("冻结清单 hash 或路径已变化");
  return value;
}
export interface AdoptionArtifacts {
  operations: AdoptionJournal["operations"];
  contents: Map<string, Buffer>;
}
/** 输出逐项核对的冻结字节与操作清单；不信任记录中的差异范围。 */
export async function adoptionArtifacts(
  workspaces: WorkspaceService,
  workspace: CodeWorkspace,
  version: CodeVersion,
): Promise<AdoptionArtifacts> {
  const directory = workspaces.directory(workspace.id);
  const baseline = await frozenManifest(
    join(directory, "baseline.json"),
    workspace.baselineHash,
  );
  const current = await frozenManifest(
    join(directory, version.id, "manifest.json"),
    version.hash,
  );
  const stored = JSON.parse(
    await readFile(join(directory, version.id, "version.json"), "utf8"),
  );
  if (
    !isDeepStrictEqual(stored, version) ||
    !isDeepStrictEqual(candidateChanges(baseline, current), version.changes)
  )
    throw new Error("冻结版本差异已变化");
  const contents = new Map<string, Buffer>();
  const operations: AdoptionJournal["operations"] = [];
  for (const change of version.changes) {
    adoptionPath.parse(change.path);
    const before = baseline.entries.find((e) => e.path === change.path) ?? null,
      after = current.entries.find((e) => e.path === change.path) ?? null;
    if (before?.link || after?.link)
      throw new Error(`不采纳符号链接改动：${change.path}`);
    for (const [entry, root, prefix] of [
      [before, join(directory, "baseline"), "before"],
      [after, join(directory, version.id, "files"), "after"],
    ] as const) {
      if (!entry) continue;
      const path = join(root, entry.path),
        info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (info.mode & 0o777) !== entry.mode
      )
        throw new Error(`冻结文件类型或权限已变化：${entry.path}`);
      const bytes = await readFile(path);
      if (hashBytes(bytes) !== entry.hash)
        throw new Error(`冻结文件内容已变化：${entry.path}`);
      contents.set(`${prefix}:${entry.path}`, bytes);
    }
    operations.push({ path: change.path, before, after, started: false });
  }
  return { operations, contents };
}
