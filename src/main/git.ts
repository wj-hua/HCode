// 新建会话时的分支选择：读本地分支、切换分支（参照 ZCode gitCliRepo 的 listLocalBranches / switchBranch）。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitBranches } from "../shared/types.js";

const run = promisify(execFile);
const TIMEOUT_MS = 10_000;

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
