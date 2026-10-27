import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { GitCommitGraphCommit, GitCommitGraphRef, GitCommitGraphResult } from "@zcode/shared";
import type { GitBranches, GitBranchSwitchPreview, GitBranchSwitchResult, GitCommitAndSwitchResult, GitWorktree } from "../shared/types.js";

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

async function readStatus(cwd: string, env: Record<string, string>): Promise<string> {
  return (await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, env, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 })).stdout;
}

function statusEntries(status: string): { path: string; status: string }[] {
  const parts = status.split("\0");
  const entries: { path: string; status: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    entries.push({ status: code, path: entry.slice(3) });
    if (/[RC]/.test(code)) i++;
  }
  return entries;
}

/** 不是 git 仓库（或没装 git）时返回 null。 */
export async function listBranches(cwd: string, env: Record<string, string>): Promise<GitBranches | null> {
  try {
    await git(cwd, env, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return null;
  }
  const [current, refs, status] = await Promise.all([
    git(cwd, env, ["branch", "--show-current"]),
    git(cwd, env, ["for-each-ref", "refs/heads", "--sort=-committerdate", "--format=%(refname:short)"]),
    readStatus(cwd, env).catch(() => null),
  ]);
  const branches = refs ? refs.split("\n") : [];
  // 还没有提交的新仓库 for-each-ref 为空，但当前分支名已经有了
  if (current && !branches.includes(current)) branches.unshift(current);
  return { current: current || null, branches, dirtyFileCount: status === null ? null : new Set(statusEntries(status).map((entry) => entry.path)).size };
}

export async function switchBranch(cwd: string, env: Record<string, string>, branch: string): Promise<GitBranchSwitchResult> {
  try {
    // 统一 Git 提示语言，确保只在明确的覆盖冲突时进入提交辅助流程。
    await git(cwd, { ...env, LC_ALL: "C", LANG: "C" }, ["switch", "--no-guess", "--", branch]);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/local changes to the following files would be overwritten by checkout|untracked working tree files would be overwritten by checkout/i.test(message)) {
      return { ok: false, reason: "changes-would-be-overwritten" };
    }
    throw error;
  }
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
  const [status, branch] = await Promise.all([readStatus(root, env), git(root, env, ["branch", "--show-current"])]);
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
  const files: GitWorktree["files"] = statusEntries(status).map(({ status: code, path }) => {
    const count = counts.get(path);
    return { path, status: code, additions: count?.[0] ?? null, deletions: count?.[1] ?? null, untracked: code === "??" };
  });
  return { root, branch: branch || null, files };
}

/** 提交辅助流程展示整个仓库的更改，因为提交会包含已暂存与未暂存的文件。 */
export async function branchSwitchPreview(cwd: string, env: Record<string, string>): Promise<GitBranchSwitchPreview> {
  const tree = await worktree(cwd, env);
  if (!tree) throw new Error("无法读取 Git 仓库状态");
  const [head, author, committer] = await Promise.all([
    git(tree.root, env, ["rev-parse", "--verify", "HEAD"]).catch(() => null),
    git(tree.root, env, ["var", "GIT_AUTHOR_IDENT"]).catch(() => null),
    git(tree.root, env, ["var", "GIT_COMMITTER_IDENT"]).catch(() => null),
  ]);
  return { branch: tree.branch, head, identityReady: Boolean(author && committer), files: tree.files.sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function commitAndSwitch(cwd: string, env: Record<string, string>, branch: string, message: string, expected: GitBranchSwitchPreview): Promise<GitCommitAndSwitchResult> {
  if (typeof branch !== "string" || !branch.trim() || typeof message !== "string" || !message.trim()) throw new Error("请填写分支和提交信息");
  const current = await branchSwitchPreview(cwd, env);
  // 文件集合或分支已变化时必须重新确认，避免提交对话框之外新增的更改。
  if (!expected || !Array.isArray(expected.files) || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("仓库状态已变化，请重新检查更改后再操作");
  if (!current.files.length) throw new Error("没有可提交的更改");
  if (!current.identityReady) throw new Error("未配置 Git 提交身份，请先在电脑上设置用户名和邮箱");
  await git(cwd, env, ["check-ref-format", "--branch", branch]);
  await git(cwd, env, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  try {
    // 只暂存预览中尚未暂存的路径；已暂存的删除项已不在索引中，不能再次对其执行 git add。
    const paths = current.files.filter((file) => file.untracked || (file.status[1] && file.status[1] !== " ")).map((file) => file.path);
    for (let index = 0; index < paths.length; index += 100) {
      await git(cwd, { ...env, GIT_TERMINAL_PROMPT: "0" }, ["--literal-pathspecs", "add", "-A", "--", ...paths.slice(index, index + 100)]);
    }
    const confirmedPaths = new Set(current.files.map((file) => file.path));
    const unconfirmedStaged = statusEntries(await readStatus(cwd, env)).some((entry) => entry.status !== "??" && entry.status[0] !== " " && !confirmedPaths.has(entry.path));
    if (unconfirmedStaged) throw new Error("暂存区出现未确认的文件，请重新检查更改");
    await commitChanges(cwd, env, message, false);
  }
  catch (error) { throw new Error(`提交失败（更改可能已暂存）：${error instanceof Error ? error.message : String(error)}`); }
  try {
    const result = await switchBranch(cwd, env, branch);
    return result.ok ? { switched: true } : { switched: false, error: "仍有更改阻止切换，请检查仓库状态" };
  } catch (error) {
    return { switched: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function graphRefs(raw: string): GitCommitGraphRef[] {
  const refs: GitCommitGraphRef[] = [];
  const add = (name: string, kind: GitCommitGraphRef["kind"]) => {
    if (name && !refs.some((ref) => ref.name === name && ref.kind === kind)) refs.push({ name, kind });
  };
  for (const value of raw.split(",")) {
    let ref = value.trim();
    if (ref.startsWith("HEAD -> ")) { add("HEAD", "head"); ref = ref.slice(8); }
    if (ref === "HEAD") add("HEAD", "head");
    else if (ref.startsWith("tag: ")) add(ref.slice(5).replace(/^refs\/tags\//, ""), "tag");
    else if (ref.startsWith("refs/heads/")) add(ref.slice(11), "branch");
    else if (ref.startsWith("refs/remotes/")) add(ref.slice(13), "remote");
    else if (ref.startsWith("refs/tags/")) add(ref.slice(10), "tag");
  }
  return refs;
}

/** 只读取 HEAD、分支、标签及远端引用，排除内部 checkpoint 引用。 */
export async function commitGraph(cwd: string, env: Record<string, string>, maxCount = 50, skip = 0): Promise<GitCommitGraphResult> {
  if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > 100 || !Number.isSafeInteger(skip) || skip < 0 || skip > 1_000_000) throw new Error("无效的 Git 图谱分页参数");
  const head = await git(cwd, env, ["rev-parse", "--verify", "HEAD"]).catch(() => null);
  if (!head && !(await git(cwd, env, ["for-each-ref", "--count=1", "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes"]))) return { commits: [], hasMore: false };
  const output = await git(cwd, env, ["log", ...(head ? ["HEAD"] : []), "--branches", "--tags", "--remotes", "--topo-order", "--date-order", "--decorate=full", `--skip=${skip}`, `--max-count=${maxCount + 1}`, "--format=%H%x00%P%x00%an%x00%at%x00%s%x00%D%x1e"]);
  const commits: GitCommitGraphCommit[] = output.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
    const [hash = "", parents = "", authorName = "", timestamp = "", subject = "", refs = ""] = record.split("\0");
    const seconds = Number.parseInt(timestamp, 10);
    return { hash, parents: parents.split(" ").filter(Boolean), authorName: authorName || null, authoredAtMs: Number.isNaN(seconds) ? null : seconds * 1000, subject, refs: graphRefs(refs) };
  }).filter((commit) => Boolean(commit.hash));
  return { commits: commits.slice(0, maxCount), hasMore: commits.length > maxCount };
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
