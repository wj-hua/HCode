// 新建会话时的分支选择：读本地分支、切换分支（参照 ZCode gitCliRepo 的 listLocalBranches / switchBranch）。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitBranches, GitTurnDiff, GitTurnFile } from "../shared/types.js";

const run = promisify(execFile);
const TIMEOUT_MS = 10_000;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

async function git(cwd: string, env: Record<string, string>, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, env, timeout: TIMEOUT_MS });
  return stdout.trim();
}

/** 不是 git 仓库（或没装 git）时返回 null。 */
export async function listBranches(cwd: string, env: Record<string, string>): Promise<GitBranches | null> {
  try {
    await git(cwd, env, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return null;
  }
  const [current, refs] = await Promise.all([
    git(cwd, env, ["branch", "--show-current"]),
    git(cwd, env, ["for-each-ref", "refs/heads", "--sort=-committerdate", "--format=%(refname:short)"]),
  ]);
  const branches = refs ? refs.split("\n") : [];
  // 还没有提交的新仓库 for-each-ref 为空，但当前分支名已经有了
  if (current && !branches.includes(current)) branches.unshift(current);
  return { current: current || null, branches };
}

export async function switchBranch(cwd: string, env: Record<string, string>, branch: string): Promise<void> {
  try {
    await git(cwd, env, ["switch", "--no-guess", branch]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
  }
}

type Snapshot = { data?: Buffer; hash: string } | null;

export interface GitTurnSnapshot {
  root: string;
  head: string | null;
  tracked: Set<string>;
  dirty: Map<string, Snapshot>;
  env: Record<string, string>;
}

async function output(cwd: string, env: Record<string, string>, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, env, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function paths(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

async function snapshotFile(path: string): Promise<Snapshot> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const data = Buffer.from(await readlink(path));
      return { data, hash: createHash("sha256").update(data).digest("hex") };
    }
    if (!info.isFile()) return { hash: `other:${info.mode}:${info.size}` };
    const hash = createHash("sha256");
    if (info.size <= MAX_PREVIEW_BYTES) {
      const data = await readFile(path);
      return { data, hash: hash.update(data).digest("hex") };
    }
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return { hash: hash.digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function worktreePaths(root: string, env: Record<string, string>, head: string | null): Promise<string[]> {
  const [changed, untracked] = await Promise.all([
    head ? output(root, env, ["diff", "--name-only", "-z", head, "--"]) : output(root, env, ["ls-files", "--cached", "-z"]),
    output(root, env, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set([...paths(changed), ...paths(untracked)])];
}

export async function isGitRepository(cwd: string, env: Record<string, string>): Promise<boolean> {
  try {
    return (await git(cwd, env, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

/** 仅把发送前已脏的文件保存在内存；干净文件可从当时的 HEAD 还原。 */
export async function beginGitTurn(cwd: string, env: Record<string, string>): Promise<GitTurnSnapshot | null> {
  if (!await isGitRepository(cwd, env)) return null;
  const root = await git(cwd, env, ["rev-parse", "--show-toplevel"]);
  const head = await git(root, env, ["rev-parse", "--verify", "HEAD"]).catch(() => null);
  const tracked = new Set(paths(await output(root, env, ["ls-files", "--cached", "-z"])));
  const dirtyPaths = await worktreePaths(root, env, head);
  const dirty = new Map<string, Snapshot>();
  for (const path of dirtyPaths) dirty.set(path, await snapshotFile(join(root, path)));
  return { root, head, tracked, dirty, env };
}

async function originalFile(turn: GitTurnSnapshot, path: string): Promise<Snapshot> {
  if (turn.dirty.has(path)) return turn.dirty.get(path)!;
  if (!turn.head || !turn.tracked.has(path)) return null;
  try {
    const { stdout } = await run("git", ["show", `${turn.head}:${path}`], {
      cwd: turn.root, env: turn.env, encoding: "buffer", timeout: TIMEOUT_MS, maxBuffer: MAX_PREVIEW_BYTES + 1024,
    });
    const data = Buffer.from(stdout);
    return { data, hash: createHash("sha256").update(data).digest("hex") };
  } catch {
    // 旧文件太大或不是普通 blob 时仍可列出变更，但不预览内容。
    return { hash: "unavailable-original" };
  }
}

async function filePatch(path: string, before: Buffer | undefined, after: Buffer | undefined, env: Record<string, string>, hadBefore: boolean, hasAfter: boolean): Promise<string | null> {
  if (!before || !after || before.includes(0) || after.includes(0)) return null;
  const dir = await mkdtemp(join(tmpdir(), "hcode-diff-"));
  try {
    const oldPath = join(dir, "before");
    const newPath = join(dir, "after");
    await Promise.all([writeFile(oldPath, before), writeFile(newPath, after)]);
    let raw = "";
    try {
      raw = await output(dir, env, ["diff", "--no-index", "--no-color", "--unified=3", "--", oldPath, newPath]);
    } catch (error) {
      raw = (error as { stdout?: string }).stdout ?? "";
    }
    const hunk = raw.indexOf("@@ ");
    if (hunk < 0) return null;
    const oldLabel = hadBefore ? `a/${path}` : "/dev/null";
    const newLabel = hasAfter ? `b/${path}` : "/dev/null";
    return `diff --git a/${path} b/${path}\n--- ${oldLabel}\n+++ ${newLabel}\n${raw.slice(hunk)}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function finishGitTurn(turn: GitTurnSnapshot): Promise<GitTurnDiff> {
  const candidates = new Set([...turn.dirty.keys(), ...await worktreePaths(turn.root, turn.env, turn.head)]);
  const files: GitTurnFile[] = [];
  for (const path of [...candidates].sort()) {
    const [before, after] = await Promise.all([originalFile(turn, path), snapshotFile(join(turn.root, path))]);
    if (before?.hash === after?.hash) continue;
    if (!before && !after) continue;
    const patch = await filePatch(path, before?.data ?? (before ? undefined : Buffer.alloc(0)), after?.data ?? (after ? undefined : Buffer.alloc(0)), turn.env, !!before, !!after);
    let additions = 0;
    let deletions = 0;
    for (const line of patch?.split("\n") ?? []) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    files.push({
      path,
      status: !before ? "added" : !after ? "deleted" : "modified",
      additions,
      deletions,
      patch,
      ...(patch === null ? { previewUnavailable: true } : {}),
    });
  }
  return { root: turn.root, files };
}
