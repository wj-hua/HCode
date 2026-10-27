import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { commitChanges, worktree, worktreeDiff } from "../git.js";

it("读取仓库状态和差异，并只在明确选择时暂存后提交", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcode-git-worktree-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "HCode Test"); git("config", "user.email", "test@example.com");
    await mkdir(join(cwd, "sub"));
    await writeFile(join(cwd, "sub", "a [1].txt"), "old\n");
    git("add", "."); git("commit", "-qm", "initial");
    await writeFile(join(cwd, "sub", "a [1].txt"), "new\n");
    await writeFile(join(cwd, "untracked.txt"), "new\n");
    const state = await worktree(join(cwd, "sub"), env);
    expect(state?.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "sub/a [1].txt", additions: 1, deletions: 1 }),
      expect.objectContaining({ path: "untracked.txt", untracked: true }),
    ]));
    expect(await worktreeDiff(cwd, env, "sub/a [1].txt")).toContain("+new");
    await expect(commitChanges(cwd, env, "test", false)).rejects.toThrow();
    expect(git("status", "--porcelain")).toContain("?? untracked.txt");
    await commitChanges(cwd, env, "test", true);
    expect(git("status", "--porcelain")).toBe("");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
