import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { listProjectFiles, withProjectFilePaths } from "../projectFiles.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("搜索 Git 项目文件，包含未跟踪文件并遵守 .gitignore", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcode-files-"));
  directories.push(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  await mkdir(join(cwd, "src"));
  await mkdir(join(cwd, "node_modules"));
  await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
  await writeFile(join(cwd, "src", "Composer.tsx"), "");
  await writeFile(join(cwd, "src", "My Composer.tsx"), "");
  await writeFile(join(cwd, "node_modules", "Composer.tsx"), "");

  expect(await listProjectFiles(cwd, "comp")).toEqual(["src/Composer.tsx", "src/My Composer.tsx"]);
  expect(await withProjectFilePaths('看 @"src/My Composer.tsx"', cwd)).toContain(join(cwd, "src", "My Composer.tsx"));
});

it("非 Git 目录递归搜索，并为不识别 @ 的 CLI 补充绝对路径", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hcode-files-"));
  directories.push(cwd);
  await mkdir(join(cwd, "src"));
  await mkdir(join(cwd, "node_modules"));
  await writeFile(join(cwd, "src", "Composer.tsx"), "");
  await writeFile(join(cwd, "node_modules", "Composer.tsx"), "");

  expect(await listProjectFiles(cwd, "comp")).toEqual(["src/Composer.tsx"]);
  expect(await withProjectFilePaths("看 @src/Composer.tsx", cwd)).toContain(join(cwd, "src", "Composer.tsx"));
  expect(await withProjectFilePaths("联系 @someone", cwd)).toBe("联系 @someone");
});
