import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { GitBranches, GitWorktree } from "../shared/types.js";

const run = promisify(execFile);
const TIMEOUT_MS = 10_000;

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

export async function worktree(cwd: string, env: Record<string, string>): Promise<GitWorktree | null> {
  let root: string;
  try { root = await repositoryRoot(cwd, env); } catch { return null; }
  const raw = async (args: string[]) => (await run("git", args, { cwd: root, env, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 })).stdout;
  const [status, branch] = await Promise.all([raw(["status", "--porcelain=v1", "-z", "--untracked-files=all"]), git(root, env, ["branch", "--show-current"])]);
  let base = "HEAD";
  try { await git(root, env, ["rev-parse", "--verify", "HEAD"]); } catch { base = ""; }
  // 尚无 HEAD 时，暂存区与工作区的差异不能直接合并成可靠的净行数。
  const stats = base ? await raw(["diff", "--numstat", "-z", base, "--"]) : "";
  const counts = new Map<string, [number | null, number | null]>();
  const statParts = stats.split("\0");
  for (let i = 0; i < statParts.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(statParts[i] ?? "");
    if (!match) continue;
    let path = match[3]!;
    if (!path) { i++; path = statParts[++i] ?? ""; }
    counts.set(path, [match[1] === "-" ? null : Number(match[1]), match[2] === "-" ? null : Number(match[2])]);
  }
  const parts = status.split("\0");
  const files: GitWorktree["files"] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2), path = entry.slice(3);
    if (/[RC]/.test(code)) i++;
    const count = counts.get(path);
    files.push({ path, status: code, additions: count?.[0] ?? null, deletions: count?.[1] ?? null, untracked: code === "??" });
  }
  return { root, branch: branch || null, files };
}

export async function worktreeDiff(cwd: string, env: Record<string, string>, path: string): Promise<string> {
  const root = await repositoryRoot(cwd, env);
  let hasHead = true;
  try { await git(root, env, ["rev-parse", "--verify", "HEAD"]); } catch { hasHead = false; }
  const args = ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-color"];
  if (hasHead) return git(root, env, [...args, "HEAD", "--", path]);
  const [staged, unstaged] = await Promise.all([
    git(root, env, [...args, "--cached", "--", path]),
    git(root, env, [...args, "--", path]),
  ]);
  return [staged, unstaged].filter(Boolean).join("\n");
}

export async function commitChanges(cwd: string, env: Record<string, string>, message: string, stageAll: boolean): Promise<void> {
  if (!message.trim()) throw new Error("请填写提交信息");
  const root = await repositoryRoot(cwd, env);
  const nonInteractive = { ...env, GIT_TERMINAL_PROMPT: "0" };
  if (stageAll) await git(root, nonInteractive, ["add", "-A", "--", "."]);
  await git(root, nonInteractive, ["commit", "-m", message.trim()]);
}

export async function pushChanges(cwd: string, env: Record<string, string>): Promise<void> {
  await git(cwd, { ...env, GIT_TERMINAL_PROMPT: "0" }, ["push"]);
}
