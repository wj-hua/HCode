// 分支选择与本轮改动：基于发送前快照提交、撤销，保留其它文件的工作区和暂存状态。
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitBranches, GitTurnDiff, GitTurnFile, GitTurnPreview, GitTurnRecord } from "../shared/types.js";

const run = promisify(execFile);
const TIMEOUT_MS = 10_000;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

async function git(cwd: string, env: Record<string, string>, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, env, timeout: TIMEOUT_MS });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
  }
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
  await git(cwd, env, ["switch", "--no-guess", "--", branch]);
}

export async function createBranch(cwd: string, env: Record<string, string>, name: string): Promise<void> {
  if (!name.trim()) throw new Error("请填写分支名称");
  await git(cwd, env, ["check-ref-format", "--branch", name]);
  await git(cwd, env, ["switch", "-c", name]);
}

export async function repositoryRoot(cwd: string, env: Record<string, string>): Promise<string> {
  return realpath(await git(cwd, env, ["rev-parse", "--show-toplevel"]));
}

export async function commitFiles(cwd: string, env: Record<string, string>, files: string[], message: string): Promise<void> {
  if (!files.length) throw new Error("请勾选要提交的文件");
  if (!message.trim()) throw new Error("请填写提交说明");
  // --literal-pathspecs 避免把文件名中的通配符解释成其它路径；--only 保留其它文件的暂存状态。
  const indexed = new Set(paths(await output(cwd, env, ["ls-files", "--cached", "-z"])));
  const toStage: string[] = [];
  for (const path of files) {
    const exists = await lstat(join(cwd, path)).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    // 已暂存删除的文件已经不在 index 中，git add 会报 pathspec 不匹配；直接交给 commit --only。
    if (exists || indexed.has(path)) toStage.push(path);
  }
  if (toStage.length) await git(cwd, env, ["--literal-pathspecs", "add", "--", ...toStage]);
  await git(cwd, env, ["--literal-pathspecs", "commit", "--only", "-m", message.trim(), "--", ...files]);
}

type Snapshot = { data?: Buffer; hash: string; mode?: number; symlink?: boolean } | null;

export interface GitTurnSnapshot {
  id: string;
  recordedAt: number;
  prompt: string;
  root: string;
  head: string | null;
  tracked: Set<string>;
  dirty: Map<string, Snapshot>;
  env: Record<string, string>;
  index: Map<string, string[]>;
  observed: Map<string, Snapshot>;
  handled: Set<string>;
  latestHead: string | null;
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
      return { data, hash: createHash("sha256").update(data).digest("hex"), symlink: true, mode: info.mode };
    }
    if (!info.isFile()) return { hash: `other:${info.mode}:${info.size}` };
    const hash = createHash("sha256");
    if (info.size <= MAX_PREVIEW_BYTES) {
      const data = await readFile(path);
      return { data, hash: hash.update(data).digest("hex"), mode: info.mode };
    }
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return { hash: hash.digest("hex"), mode: info.mode };
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
export async function beginGitTurn(cwd: string, env: Record<string, string>, prompt = ""): Promise<GitTurnSnapshot | null> {
  if (!await isGitRepository(cwd, env)) return null;
  const root = await repositoryRoot(cwd, env);
  const head = await git(root, env, ["rev-parse", "--verify", "HEAD"]).catch(() => null);
  const tracked = new Set(paths(await output(root, env, ["ls-files", "--cached", "-z"])));
  const dirtyPaths = await worktreePaths(root, env, head);
  const dirty = new Map<string, Snapshot>();
  for (const path of dirtyPaths) dirty.set(path, await snapshotFile(join(root, path)));
  const index = new Map<string, string[]>();
  for (const entry of paths(await output(root, env, ["ls-files", "--stage", "-z"]))) {
    const tab = entry.indexOf("\t");
    const path = entry.slice(tab + 1);
    index.set(path, [...(index.get(path) ?? []), entry.slice(0, tab)]);
  }
  return {
    id: randomUUID(), recordedAt: Date.now(), prompt: prompt.split(/\r?\n/)[0]?.trim().slice(0, 200) ?? "",
    root, head, tracked, dirty, env, index, observed: new Map(), handled: new Set(), latestHead: head,
  };
}

async function safeRepoPath(root: string, path: string): Promise<void> {
  if (!path || isAbsolute(path) || path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")) {
    throw new Error(`文件路径无效：${path}`);
  }
  // 文件本身可以是符号链接，但父目录不能跳出仓库；删除的目录逐级检查仍存在的祖先。
  let parent = dirname(resolve(root, path));
  while (true) {
    try { parent = await realpath(parent); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      parent = dirname(parent);
    }
  }
  const fromRoot = relative(root, parent);
  if (fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) throw new Error(`文件路径已指向仓库外：${path}`);
  if (fromRoot.split("/").some((part) => part.toLowerCase() === ".git")) throw new Error(`文件路径指向 Git 元数据：${path}`);
}

/** 操作仅接受最近一次面板实际列出的文件，过期预览不能覆盖后来的改动。 */
export async function validateTurnFiles(turn: GitTurnSnapshot, files: string[]): Promise<void> {
  const head = await git(turn.root, turn.env, ["rev-parse", "--verify", "HEAD"]).catch(() => null);
  if (head !== turn.latestHead) throw new Error("仓库 HEAD 已变化，请刷新改动后重试");
  for (const path of files) {
    if (!turn.observed.has(path) || turn.handled.has(path) || isAbsolute(path) || path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")) {
      throw new Error(`文件不在当前本轮改动中：${path}`);
    }
    await safeRepoPath(turn.root, path);
    const current = await snapshotFile(join(turn.root, path));
    const expected = turn.observed.get(path);
    if (current?.hash !== expected?.hash || current?.mode !== expected?.mode || current?.symlink !== expected?.symlink) {
      throw new Error(`文件在预览后已变化，请刷新后重试：${path}`);
    }
  }
}

export async function revertFile(turn: GitTurnSnapshot, path: string): Promise<void> {
  await validateTurnFiles(turn, [path]);
  const originalIndex = turn.index.get(path) ?? [];
  if (originalIndex.some((entry) => !entry.endsWith(" 0"))) throw new Error("发送前文件存在合并冲突，请在终端处理");
  if (originalIndex.some((entry) => entry.startsWith("160000 "))) throw new Error("子模块改动请在终端处理");
  const target = join(turn.root, path);
  if (turn.dirty.has(path)) {
    const before = turn.dirty.get(path)!;
    if (before && !before.data) throw new Error("发送前文件超过快照大小限制，无法安全撤销，请在编辑器处理");
    if (before) {
      await mkdir(dirname(target), { recursive: true });
      const current = await lstat(target).catch(() => null);
      if (current?.isSymbolicLink() || before.symlink) await rm(target, { force: true });
      if (before.symlink) await symlink(before.data!.toString(), target);
      else {
        await writeFile(target, before.data!);
        if (before.mode !== undefined) await chmod(target, before.mode);
      }
    } else {
      const { trashPaths } = await import("./util/trash.js");
      await trashPaths([target]);
    }
  } else if (turn.head && turn.tracked.has(path)) {
    await git(turn.root, turn.env, ["--literal-pathspecs", "restore", `--source=${turn.head}`, "--worktree", "--", path]);
  } else {
    const { trashPaths } = await import("./util/trash.js");
    await trashPaths([target]);
  }
  // 恢复发送前该文件的暂存记录，其它文件的 index 不变。
  if (originalIndex.length) {
    const [mode, oid] = originalIndex[0]!.split(" ");
    await git(turn.root, turn.env, ["update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`]);
  } else {
    await git(turn.root, turn.env, ["--literal-pathspecs", "update-index", "--force-remove", "--", path]);
  }
  turn.handled.add(path);
}

async function originalFile(turn: Pick<GitTurnSnapshot, "root" | "head" | "tracked" | "dirty" | "env">, path: string): Promise<Snapshot> {
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
  turn.observed.clear();
  for (const path of [...candidates].sort()) {
    if (turn.handled.has(path)) continue;
    const [before, after] = await Promise.all([originalFile(turn, path), snapshotFile(join(turn.root, path))]);
    if (before?.hash === after?.hash) continue;
    if (!before && !after) continue;
    turn.observed.set(path, after);
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
      beforeHash: before?.hash ?? null,
      afterHash: after?.hash ?? null,
      ...(turn.index.get(path)?.some((entry) => entry.startsWith("160000 "))
        ? { revertUnavailable: "子模块改动请在终端处理" }
        : turn.dirty.get(path) && !turn.dirty.get(path)?.data
          ? { revertUnavailable: "发送前文件超过快照大小限制，无法安全撤销" }
          : {}),
    });
  }
  turn.latestHead = await git(turn.root, turn.env, ["rev-parse", "--verify", "HEAD"]).catch(() => null);
  return { id: turn.id, head: turn.head, recordedAt: turn.recordedAt, prompt: turn.prompt, root: turn.root, files };
}

/** 仅重建历史预览，不建立 F20 可写快照；保存的文件清单与行数始终由记录提供。 */
export async function previewGitTurn(cwd: string, env: Record<string, string>, record: GitTurnRecord): Promise<GitTurnPreview> {
  const root = await repositoryRoot(cwd, env);
  if (await realpath(record.root) !== root) throw new Error("改动记录属于不同的 Git 仓库");
  if (record.head !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.head)) throw new Error("改动记录的 Git HEAD 无效");
  for (const file of record.files) await safeRepoPath(root, file.path);
  const tracked = new Set(record.head ? paths(await output(root, env, ["ls-tree", "-r", "--name-only", "-z", record.head])) : []);
  const base = { root, env, head: record.head, tracked, dirty: new Map<string, Snapshot>() };
  const files: GitTurnPreview["files"] = [];
  for (const file of record.files) {
    const [before, after] = await Promise.all([originalFile(base, file.path), snapshotFile(join(root, file.path))]);
    const patch = await filePatch(file.path, before?.data ?? (before ? undefined : Buffer.alloc(0)), after?.data ?? (after ? undefined : Buffer.alloc(0)), env, !!before, !!after);
    files.push({
      path: file.path,
      patch,
      changed: file.afterHash !== undefined && file.afterHash !== (after?.hash ?? null),
      baselineChanged: file.beforeHash !== undefined && file.beforeHash !== (before?.hash ?? null),
    });
  }
  return { files };
}
