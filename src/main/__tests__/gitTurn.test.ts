import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { beginGitTurn, finishGitTurn } from "../git.js";

it("只显示本轮相对于发送前的改动，包含已有脏文件、新文件和提交后的修改", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcode-git-turn-test-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env });
  try {
    git("init", "-q");
    git("config", "user.name", "HCode Test");
    git("config", "user.email", "test@example.com");
    await writeFile(join(cwd, "existing.txt"), "original\n");
    await writeFile(join(cwd, "deleted.txt"), "remove me\n");
    git("add", ".");
    git("commit", "-qm", "initial");
    await writeFile(join(cwd, "existing.txt"), "before turn\n");
    await writeFile(join(cwd, "untouched.txt"), "already here\n");

    const turn = await beginGitTurn(cwd, env);
    expect(turn).not.toBeNull();
    await writeFile(join(cwd, "existing.txt"), "during turn\n");
    await writeFile(join(cwd, "added.txt"), "new file\n");
    await rm(join(cwd, "deleted.txt"));
    git("add", "-A");
    git("commit", "-qm", "turn changes");

    const result = await finishGitTurn(turn!);
    expect(result.files.map((file) => file.path)).toEqual(["added.txt", "deleted.txt", "existing.txt"]);
    const existing = result.files.find((file) => file.path === "existing.txt")!;
    expect(existing.patch).toContain("-before turn");
    expect(existing.patch).toContain("+during turn");
    expect(existing.patch).not.toContain("-original");
    expect(existing).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
    expect(await readFile(join(cwd, "untouched.txt"), "utf8")).toBe("already here\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
