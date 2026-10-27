import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { branchSwitchPreview, commitAndSwitch, createBranch, listBranches, switchBranch } from "../git.js";

it("创建并切换分支，非法名称不会改变当前分支", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcode-git-branches-test-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "HCode Test");
    git("config", "user.email", "test@example.com");
    git("commit", "--allow-empty", "-qm", "initial");
    const original = git("branch", "--show-current");
    await createBranch(cwd, env, "feature/test");
    expect((await listBranches(cwd, env))?.current).toBe("feature/test");
    await expect(createBranch(cwd, env, "invalid name")).rejects.toThrow();
    expect(git("branch", "--show-current")).toBe("feature/test");
    expect(await switchBranch(cwd, env, original)).toEqual({ ok: true });
    expect(git("branch", "--show-current")).toBe(original);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("切换会覆盖更改时提供预览，状态改变后拒绝提交，确认后提交并切换", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcode-git-switch-test-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "HCode Test"); git("config", "user.email", "test@example.com");
    await writeFile(join(cwd, "file.txt"), "base\n"); await writeFile(join(cwd, "delete.txt"), "delete\n"); git("add", "."); git("commit", "-qm", "initial");
    const original = git("branch", "--show-current");
    git("switch", "-qc", "other"); await writeFile(join(cwd, "file.txt"), "other\n"); git("commit", "-qam", "other");
    git("switch", "-q", original); await writeFile(join(cwd, "file.txt"), "local\n"); git("rm", "-q", "delete.txt");
    expect((await listBranches(cwd, env))?.dirtyFileCount).toBe(2);
    expect(await switchBranch(cwd, env, "other")).toEqual({ ok: false, reason: "changes-would-be-overwritten" });
    const stale = await branchSwitchPreview(cwd, env);
    expect(stale.files.map((file) => file.path)).toEqual(["delete.txt", "file.txt"]);
    await writeFile(join(cwd, "new [1].txt"), "new\n");
    await expect(commitAndSwitch(cwd, env, "other", "save local changes", stale)).rejects.toThrow("仓库状态已变化");
    expect(git("status", "--porcelain")).toContain("new [1].txt");
    const preview = await branchSwitchPreview(cwd, env);
    await expect(commitAndSwitch(cwd, env, "missing-branch", "save local changes", preview)).rejects.toThrow();
    expect(git("diff", "--cached", "--name-only")).toBe("delete.txt");
    expect(await commitAndSwitch(cwd, env, "other", "save local changes", preview)).toEqual({ switched: true });
    expect(git("branch", "--show-current")).toBe("other");
    expect(git("show", `${original}:file.txt`)).toBe("local");
    expect(git("show", `${original}:new [1].txt`)).toBe("new");
    expect(git("show", "HEAD:file.txt")).toBe("other");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it("未跟踪文件阻止切换时同样进入预览流程", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcode-git-untracked-test-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "HCode Test"); git("config", "user.email", "test@example.com");
    git("commit", "--allow-empty", "-qm", "initial");
    const original = git("branch", "--show-current");
    git("switch", "-qc", "other"); await writeFile(join(cwd, "new.txt"), "other\n"); git("add", "."); git("commit", "-qm", "other");
    git("switch", "-q", original); await writeFile(join(cwd, "new.txt"), "local\n");
    expect(await switchBranch(cwd, env, "other")).toEqual({ ok: false, reason: "changes-would-be-overwritten" });
    const preview = await branchSwitchPreview(cwd, env);
    expect(preview.files).toEqual([expect.objectContaining({ path: "new.txt", untracked: true })]);
    expect(await commitAndSwitch(cwd, env, "other", "save untracked file", preview)).toEqual({ switched: true });
    expect(git("show", `${original}:new.txt`)).toBe("local");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it("缺少 Git 提交身份时不暂存或提交文件", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcode-git-identity-test-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete env[key];
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "HCode Test"); git("config", "user.email", "test@example.com");
    await writeFile(join(cwd, "file.txt"), "base\n"); git("add", "."); git("commit", "-qm", "initial");
    git("branch", "other"); await writeFile(join(cwd, "file.txt"), "local\n");
    git("config", "user.name", ""); git("config", "user.email", "");
    const preview = await branchSwitchPreview(cwd, env);
    expect(preview.identityReady).toBe(false);
    await expect(commitAndSwitch(cwd, env, "other", "save changes", preview)).rejects.toThrow("提交身份");
    expect(git("diff", "--cached", "--name-only")).toBe("");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it("同一路径被暂存删除后重新创建时，只计一个文件并提交新内容", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcode-git-recreated-test-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "HCode Test"); git("config", "user.email", "test@example.com");
    await writeFile(join(cwd, "file.txt"), "old\n"); git("add", "."); git("commit", "-qm", "initial");
    const original = git("branch", "--show-current");
    git("branch", "other"); git("rm", "-q", "file.txt"); await writeFile(join(cwd, "file.txt"), "new\n");
    expect((await listBranches(cwd, env))?.dirtyFileCount).toBe(1);
    const preview = await branchSwitchPreview(cwd, env);
    expect(await commitAndSwitch(cwd, env, "other", "save replacement", preview)).toEqual({ switched: true });
    expect(git("show", `${original}:file.txt`)).toBe("new");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
