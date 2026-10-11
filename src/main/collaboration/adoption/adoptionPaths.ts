// 不跟随目标/祖先链接；重复核对根目录身份，文件状态用于冲突和保守恢复。
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { FileEntry } from "../workspaces/fileManifest.js";
import { hashBytes } from "../workspaces/fileManifest.js";
import { adoptionPath, type AdoptionJournal } from "./adoptionContracts.js";
export async function optionalStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function assertOriginalRoot(
  journal: Pick<AdoptionJournal, "originalPath" | "rootDevice" | "rootInode">,
) {
  const info = await lstat(journal.originalPath);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== journal.rootDevice ||
    info.ino !== journal.rootInode ||
    (await realpath(journal.originalPath)) !== journal.originalPath
  )
    throw new Error("原项目目录身份已变化，不能写入");
}
export async function guardedTarget(root: string, path: string) {
  adoptionPath.parse(path);
  let current = root;
  for (const part of path.split("/").slice(0, -1)) {
    current = join(current, part);
    const info = await optionalStat(current);
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error(`目标祖先不是普通目录：${relative(root, current)}`);
  }
  return join(root, path);
}
/** 拒绝链接与特殊文件，读取期间状态变化报错；缺文件返回 null。 */
export async function fileState(
  root: string,
  path: string,
): Promise<FileEntry | null> {
  const target = await guardedTarget(root, path),
    info = await optionalStat(target);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`目标不是普通文件：${path}`);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const start = await handle.stat(),
      bytes = await handle.readFile(),
      finish = await handle.stat(),
      actual = await lstat(target);
    if (
      start.ino !== actual.ino ||
      start.dev !== actual.dev ||
      start.mtimeMs !== finish.mtimeMs ||
      start.size !== finish.size ||
      start.mode !== finish.mode
    )
      throw new Error(`文件读取时变化：${path}`);
    return {
      path,
      hash: hashBytes(bytes),
      mode: finish.mode & 0o777,
      bytes: bytes.length,
      binary: bytes.includes(0),
    };
  } finally {
    await handle.close();
  }
}
export function sameFile(actual: FileEntry | null, expected: FileEntry | null) {
  return actual === null
    ? expected === null
    : expected !== null &&
        actual.hash === expected.hash &&
        actual.mode === expected.mode;
}
export function parentPaths(path: string) {
  const parents: string[] = [];
  let current = dirname(path);
  while (current !== ".") {
    parents.unshift(current);
    current = dirname(current);
  }
  return parents;
}
