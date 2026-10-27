import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createBranch, listBranches, switchBranch } from "../git.js";

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
    await switchBranch(cwd, env, original);
    expect(git("branch", "--show-current")).toBe(original);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
