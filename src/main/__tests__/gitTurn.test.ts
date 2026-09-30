import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginGitTurn, commitFiles, createBranch, finishGitTurn, previewGitTurn, revertFile, switchBranch, validateTurnFiles } from "../git.js";
import type { GitTurnDiff, GitTurnRecord } from "../../shared/types.js";
import { trashPaths } from "../util/trash.js";

// 单元测试不触碰系统废纸篓；断言调用后在临时仓库模拟移走文件。
vi.mock("../util/trash.js", () => ({ trashPaths: vi.fn(async (files: string[]) => {
  for (const path of files) await rm(path, { force: true });
  return files.length;
}) }));

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

describe("F20 Git 提交与撤销", () => {
  let cwd: string;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const write = (path: string, text: string) => writeFile(join(cwd, path), text);
  const record = (diff: GitTurnDiff): GitTurnRecord => ({
    id: diff.id!, root: diff.root!, head: diff.head!, recordedAt: diff.recordedAt!, prompt: diff.prompt!,
    files: diff.files.map(({ patch: _patch, revertUnavailable: _runtime, ...file }) => file),
  });

  beforeEach(async () => {
    vi.mocked(trashPaths).mockClear();
    cwd = await mkdtemp(join(tmpdir(), "hcode-git-actions-test-"));
    git("init", "-q");
    git("config", "user.name", "HCode Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    for (const path of ["one.txt", "two.txt", "three.txt", "other.txt"]) await write(path, "original\n");
    git("add", ".");
    git("commit", "-qm", "initial");
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("撤销一个文件后提交另两个，保留本轮外文件的暂存和工作区内容", async () => {
    await write("other.txt", "staged before turn\n");
    git("add", "other.txt");
    await write("other.txt", "unstaged before turn\n");
    const otherIndex = git("show", ":other.txt");
    const turn = (await beginGitTurn(cwd, env))!;
    for (const path of ["one.txt", "two.txt", "three.txt"]) await write(path, "during turn\n");
    git("add", "one.txt");
    expect((await finishGitTurn(turn)).files.map((file) => file.path)).toEqual(["one.txt", "three.txt", "two.txt"]);

    await revertFile(turn, "one.txt");
    expect(await readFile(join(cwd, "one.txt"), "utf8")).toBe("original\n");
    expect(git("diff", "--cached", "--name-only")).toBe("other.txt");
    await finishGitTurn(turn);
    await validateTurnFiles(turn, ["two.txt", "three.txt"]);
    await commitFiles(cwd, env, ["two.txt", "three.txt"], "selected changes");
    for (const path of ["two.txt", "three.txt"]) turn.handled.add(path);
    expect((await finishGitTurn(turn)).files).toEqual([]);
    expect(git("log", "-1", "--format=%s")).toBe("selected changes");
    expect(git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe("three.txt\ntwo.txt");
    expect(git("show", ":other.txt")).toBe(otherIndex);
    expect(await readFile(join(cwd, "other.txt"), "utf8")).toBe("unstaged before turn\n");
  });

  it("撤销恢复发送前已有脏文件的内容、权限及暂存内容", async () => {
    await write("one.txt", "staged before\n");
    git("add", "one.txt");
    await write("one.txt", "unstaged before\n");
    await chmod(join(cwd, "one.txt"), 0o755);
    const turn = (await beginGitTurn(cwd, env))!;
    await write("one.txt", "CLI changed\n");
    await chmod(join(cwd, "one.txt"), 0o644);
    git("add", "one.txt");
    await finishGitTurn(turn);
    await revertFile(turn, "one.txt");
    expect(await readFile(join(cwd, "one.txt"), "utf8")).toBe("unstaged before\n");
    expect(git("show", ":one.txt")).toBe("staged before");
    expect((await stat(join(cwd, "one.txt"))).mode & 0o777).toBe(0o755);
    expect((await finishGitTurn(turn)).files).toEqual([]);
  });

  it("新增文件移到废纸篓，已暂存的删除文件恢复，已有未跟踪文件保留", async () => {
    await write("existing-new.txt", "already here\n");
    const turn = (await beginGitTurn(cwd, env))!;
    await write("new.txt", "new\n");
    await write("existing-new.txt", "changed during turn\n");
    await rm(join(cwd, "two.txt"));
    git("add", "-A");
    await finishGitTurn(turn);
    await revertFile(turn, "new.txt");
    await revertFile(turn, "two.txt");
    await revertFile(turn, "existing-new.txt");
    expect(trashPaths).toHaveBeenCalledExactlyOnceWith([join(turn.root, "new.txt")]);
    expect(await readFile(join(cwd, "two.txt"), "utf8")).toBe("original\n");
    expect(await readFile(join(cwd, "existing-new.txt"), "utf8")).toBe("already here\n");
    expect(git("diff", "--cached", "--name-only")).toBe("");
    expect((await finishGitTurn(turn)).files).toEqual([]);
  });

  it("过期预览和面板外路径不能被撤销或提交，刷新后可重试", async () => {
    const turn = (await beginGitTurn(cwd, env))!;
    await write("one.txt", "first change\n");
    await finishGitTurn(turn);
    await write("one.txt", "later edit\n");
    await expect(revertFile(turn, "one.txt")).rejects.toThrow("文件在预览后已变化");
    await expect(validateTurnFiles(turn, ["other.txt"])).rejects.toThrow("文件不在当前本轮改动中");
    await expect(validateTurnFiles(turn, ["../outside.txt"])).rejects.toThrow("文件不在当前本轮改动中");
    expect(await readFile(join(cwd, "one.txt"), "utf8")).toBe("later edit\n");
    await finishGitTurn(turn);
    await validateTurnFiles(turn, ["one.txt"]);
    git("commit", "--allow-empty", "-qm", "external commit");
    await expect(revertFile(turn, "one.txt")).rejects.toThrow("仓库 HEAD 已变化");
  });

  it("提交新增、删除与含通配符的文件，空说明不修改暂存区", async () => {
    await write("[name].txt", "literal\n");
    await write("n.txt", "unselected\n");
    await rm(join(cwd, "two.txt"));
    git("add", "-A");
    const index = git("ls-files", "--stage");
    await expect(commitFiles(cwd, env, ["[name].txt"], "  ")).rejects.toThrow("请填写提交说明");
    expect(git("ls-files", "--stage")).toBe(index);
    await commitFiles(cwd, env, ["[name].txt", "two.txt"], "add and delete");
    expect(git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe("[name].txt\ntwo.txt");
    expect(git("status", "--porcelain")).toBe("A  n.txt");
  });

  it("无 HEAD 的新仓库可提交选中文件，保留其他暂存文件", async () => {
    const fresh = join(cwd, "fresh");
    await mkdir(fresh);
    const freshGit = (...args: string[]) => execFileSync("git", args, { cwd: fresh, env, encoding: "utf8" }).trim();
    freshGit("init", "-q");
    freshGit("config", "user.name", "HCode Test");
    freshGit("config", "user.email", "test@example.com");
    freshGit("config", "commit.gpgsign", "false");
    await writeFile(join(fresh, "selected.txt"), "selected\n");
    await writeFile(join(fresh, "other.txt"), "other\n");
    freshGit("add", "other.txt");
    await commitFiles(fresh, env, ["selected.txt"], "first commit");
    expect(freshGit("ls-tree", "--name-only", "HEAD")).toBe("selected.txt");
    expect(freshGit("diff", "--cached", "--name-only")).toBe("other.txt");
  });

  it("已有符号链接撤销时恢复链接目标而不写入目标文件", async () => {
    await symlink("other.txt", join(cwd, "link.txt"));
    const turn = (await beginGitTurn(cwd, env))!;
    await rm(join(cwd, "link.txt"));
    await write("link.txt", "replaced\n");
    await finishGitTurn(turn);
    await revertFile(turn, "link.txt");
    expect(await readlink(join(cwd, "link.txt"))).toBe("other.txt");
    expect(await readFile(join(cwd, "other.txt"), "utf8")).toBe("original\n");
  });

  it("创建并切换分支，重复或非法名称返回 Git 错误且保留当前分支", async () => {
    const original = git("branch", "--show-current");
    await createBranch(cwd, env, "feature/f20");
    expect(git("branch", "--show-current")).toBe("feature/f20");
    await expect(createBranch(cwd, env, "feature/f20")).rejects.toThrow("already exists");
    await expect(createBranch(cwd, env, "invalid name")).rejects.toThrow("not a valid branch name");
    expect(git("branch", "--show-current")).toBe("feature/f20");
    await switchBranch(cwd, env, original);
    expect(git("branch", "--show-current")).toBe(original);
  });

  it("历史摘要保存发送时 HEAD，重启后重建已提交、新增和删除文件的差异", async () => {
    const head = git("rev-parse", "HEAD");
    const turn = (await beginGitTurn(cwd, env, "修改三个文件\n更多说明"))!;
    await write("one.txt", "changed\n");
    await write("new file.txt", "added\n");
    await rm(join(cwd, "two.txt"));
    git("add", "-A");
    git("commit", "-qm", "CLI commit");
    const diff = await finishGitTurn(turn);
    expect(diff).toMatchObject({ head, id: turn.id, recordedAt: turn.recordedAt, prompt: "修改三个文件" });
    const saved = JSON.parse(JSON.stringify(record(diff))) as GitTurnRecord;
    const beforeStatus = git("status", "--porcelain");
    const preview = await previewGitTurn(cwd, env, saved);
    expect(preview.files.map((file) => file.path)).toEqual(["new file.txt", "one.txt", "two.txt"]);
    for (const file of preview.files) {
      expect(file.patch).toBe(diff.files.find((item) => item.path === file.path)?.patch);
      expect(file.changed).toBe(false);
      expect(file.baselineChanged).toBe(false);
    }
    expect(git("status", "--porcelain")).toBe(beforeStatus);
    expect((await finishGitTurn(turn)).id).toBe(saved.id);
  });

  it("文件后来变化会标记不一致，预览不修改保存的行数或暂存状态", async () => {
    const turn = (await beginGitTurn(cwd, env))!;
    await write("one.txt", "during turn\n");
    const saved = record(await finishGitTurn(turn));
    await write("one.txt", "later\nmore lines\n");
    git("add", "one.txt");
    const index = git("ls-files", "--stage");
    const preview = await previewGitTurn(cwd, env, saved);
    expect(preview.files[0]).toMatchObject({ changed: true, baselineChanged: false });
    expect(preview.files[0]?.patch).toContain("+later");
    expect(saved.files[0]).toMatchObject({ additions: 1, deletions: 1 });
    expect(git("ls-files", "--stage")).toBe(index);
  });

  it("发送前已有脏内容时标明基线无法准确重建，而不把 HEAD 预览当作当时差异", async () => {
    await write("one.txt", "before turn\n");
    const turn = (await beginGitTurn(cwd, env))!;
    await write("one.txt", "during turn\n");
    const diff = await finishGitTurn(turn);
    const preview = await previewGitTurn(cwd, env, record(diff));
    expect(diff.files[0]?.patch).toContain("-before turn");
    expect(preview.files[0]).toMatchObject({ changed: false, baselineChanged: true });
    expect(preview.files[0]?.patch).toContain("-original");
  });

  it("历史预览拒绝越界路径、元数据路径和伪造 HEAD", async () => {
    const turn = (await beginGitTurn(cwd, env))!;
    await write("one.txt", "changed\n");
    const saved = record(await finishGitTurn(turn));
    for (const path of ["../outside.txt", ".git/config"]) {
      await expect(previewGitTurn(cwd, env, { ...saved, files: [{ ...saved.files[0]!, path }] })).rejects.toThrow("文件路径无效");
    }
    await symlink(tmpdir(), join(cwd, "escape"));
    await expect(previewGitTurn(cwd, env, { ...saved, files: [{ ...saved.files[0]!, path: "escape/outside.txt" }] })).rejects.toThrow("仓库外");
    await expect(previewGitTurn(cwd, env, { ...saved, head: "--output=/tmp/invalid" })).rejects.toThrow("HEAD 无效");
    await expect(previewGitTurn(cwd, env, { ...saved, root: tmpdir() })).rejects.toThrow("不同的 Git 仓库");
  });

  it("没有初始提交的记录也能预览新增文件，二进制不传正文", async () => {
    git("switch", "--quiet", "--orphan", "unborn");
    const turn = (await beginGitTurn(cwd, env))!;
    await write("new.txt", "new\n");
    await writeFile(join(cwd, "binary.dat"), Buffer.from([0, 1, 2]));
    const saved = record(await finishGitTurn(turn));
    expect(saved.head).toBeNull();
    const preview = await previewGitTurn(cwd, env, saved);
    expect(preview.files.find((file) => file.path === "new.txt")).toMatchObject({ changed: false, baselineChanged: false });
    expect(preview.files.find((file) => file.path === "new.txt")?.patch).toContain("+new");
    expect(preview.files.find((file) => file.path === "binary.dat")?.patch).toBeNull();
  });
});
