import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { browseProjectDirectories, prepareProjectDirectory } from "../projectDirectory.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it("只添加已有目录，或创建父目录已存在的新目录", async () => {
  root = await mkdtemp(join(tmpdir(), "hcode-project-"));
  const existing = join(root, "existing");
  const created = join(root, "created");
  await mkdir(existing);
  await writeFile(join(root, "file"), "data");
  expect(await prepareProjectDirectory(existing, false, join(root, "conversation"))).toBe(existing);
  expect(await prepareProjectDirectory(created, true, join(root, "conversation"))).toBe(created);
  await expect(prepareProjectDirectory(created, true, "")).rejects.toThrow();
  await expect(prepareProjectDirectory(join(root, "missing", "child"), true, "")).rejects.toThrow();
  await expect(prepareProjectDirectory(join(root, "file"), false, "")).rejects.toThrow("路径不是文件夹");
  await expect(prepareProjectDirectory("relative", false, "")).rejects.toThrow("绝对目录路径");
  await expect(prepareProjectDirectory(existing, false, existing)).rejects.toThrow("对话目录");
});

it("浏览目录时只返回文件夹，支持隐藏目录和指向文件夹的链接", async () => {
  root = await mkdtemp(join(tmpdir(), "hcode-browser-"));
  await mkdir(join(root, "visible"));
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, "file"), "data");
  await symlink(join(root, "visible"), join(root, "shortcut"), "dir");
  await symlink(join(root, "missing"), join(root, "broken"), "dir");

  const visible = await browseProjectDirectories(root, false);
  expect(visible.path).toBe(root);
  expect(visible.parent).toBe(dirname(root));
  expect(visible.directories).toEqual([
    { name: "shortcut", path: join(root, "shortcut"), isSymbolicLink: true },
    { name: "visible", path: join(root, "visible"), isSymbolicLink: false },
  ]);
  expect((await browseProjectDirectories(root, true)).directories.map((item) => item.name)).toContain(".hidden");
  expect((await browseProjectDirectories(resolve(root, ".."), false)).path).toBe(dirname(root));
  expect((await browseProjectDirectories(resolve(root, "/"), false)).parent).toBeNull();
});

it("从宿主机主目录开始，并拒绝无效或无法读取的路径", async () => {
  root = await mkdtemp(join(tmpdir(), "hcode-browser-"));
  expect((await browseProjectDirectories(null, false)).path).toBe(resolve(homedir()));
  await expect(browseProjectDirectories("relative", false)).rejects.toThrow("绝对目录路径");
  await expect(browseProjectDirectories(root, "true")).rejects.toThrow("绝对目录路径");
  await expect(browseProjectDirectories(join(root, "missing"), false)).rejects.toThrow();
});
