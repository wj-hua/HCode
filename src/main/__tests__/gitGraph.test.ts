import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { commitGraph } from "../git.js";

it("图谱支持空仓库、分支和分页，不展示内部引用的独立提交", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcode-git-graph-test-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "HCode Test"); git("config", "user.email", "test@example.com");
    expect(await commitGraph(cwd, env)).toEqual({ commits: [], hasMore: false });
    git("commit", "--allow-empty", "-qm", "first");
    git("commit", "--allow-empty", "-qm", "second");
    git("tag", "v1");
    const hidden = execFileSync("git", ["commit-tree", "HEAD^{tree}"], { cwd, env, encoding: "utf8", input: "internal\n" }).trim();
    git("update-ref", "refs/hcode/checkpoints/hidden", hidden);
    const first = await commitGraph(cwd, env, 1, 0);
    expect(first.hasMore).toBe(true);
    expect(first.commits[0]).toMatchObject({ subject: "second", parents: [git("rev-parse", "HEAD^")] });
    expect(first.commits[0]?.refs).toEqual(expect.arrayContaining([{ name: "HEAD", kind: "head" }, { name: "v1", kind: "tag" }]));
    const second = await commitGraph(cwd, env, 1, 1);
    expect(second.commits.map((commit) => commit.subject)).toEqual(["first"]);
    expect(second.hasMore).toBe(false);
    expect([...first.commits, ...second.commits].map((commit) => commit.hash)).not.toContain(hidden);
    await expect(commitGraph(cwd, env, 1000, 0)).rejects.toThrow("分页参数");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
