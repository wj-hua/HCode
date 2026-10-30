/** 从远程文件调用边界验证实际磁盘内容、项目授权和读取上限。 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { invokeRemoteFile } from "../filePreview.js";

let root: string;
let project: string;
beforeEach(async () => {
  // 项目必须位于系统临时目录外，否则无法区分项目授权与临时产物授权。
  root = await mkdtemp(join(process.cwd(), ".hcode-preview-test-"));
  project = join(root, "project");
  await mkdir(project);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("读取已添加项目的文本、空文件和目录信息，项目移除后拒绝继续读取", async () => {
  const path = join(project, "说明.md");
  await writeFile(path, "你好");
  expect(await invokeRemoteFile("fs:readText", [path], [project])).toBe("你好");
  expect(await invokeRemoteFile("fs:stat", [project], [project])).toMatchObject({ exists: true, isDirectory: true });
  await writeFile(path, "");
  expect(await invokeRemoteFile("fs:readText", [path, 0], [project])).toBe("");
  await expect(invokeRemoteFile("fs:readText", [path], [])).rejects.toThrow("超出远程预览范围");
});

it("工作区的符号链接和 macOS 临时目录别名按真实路径核验", async () => {
  const path = join(project, "data.txt");
  await writeFile(path, "text");
  const alias = join(root, "project-link");
  await symlink(project, alias);
  expect(await invokeRemoteFile("fs:readText", [join(alias, "data.txt")], [alias])).toBe("text");
  const temp = await mkdtemp(join(tmpdir(), "hcode-preview-"));
  try {
    const image = join(temp, "截图.png");
    await writeFile(image, Uint8Array.from([0, 128, 255]));
    expect(await invokeRemoteFile("fs:readMedia", [image], [])).toBe("AID/");
  } finally { await rm(temp, { recursive: true, force: true }); }
});

it("拒绝同名前缀目录、路径穿越和符号链接逃逸", async () => {
  const outside = join(root, "project-other");
  await mkdir(outside);
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "private");
  const linked = join(project, "linked.txt");
  await symlink(secret, linked);
  for (const path of [secret, `${project}/../project-other/secret.txt`, linked]) {
    for (const channel of ["fs:stat", "fs:readText", "fs:readMedia"] as const) {
      await expect(invokeRemoteFile(channel, [path], [project])).rejects.toThrow("超出远程预览范围");
    }
  }
});

it("缺失文件返回 null，无效路径和读取参数明确失败", async () => {
  expect(await invokeRemoteFile("fs:stat", [join(project, "missing")], [project])).toBeNull();
  for (const path of [undefined, 123, "relative.md", "/tmp/invalid\0path"]) {
    await expect(invokeRemoteFile("fs:stat", [path], [project])).rejects.toThrow("有效的绝对路径");
  }
  const path = join(project, "text.txt");
  await writeFile(path, "你好");
  for (const limit of [-1, Infinity, "large"]) {
    await expect(invokeRemoteFile("fs:readText", [path, limit], [project])).rejects.toThrow("字节上限无效");
  }
  expect(await invokeRemoteFile("fs:readText", [path, 5], [project])).toBeNull();
});

it("文本保持 UTF-8 和二进制边界，客户端不能提升 256 KiB 上限", async () => {
  const path = join(project, "text.txt");
  for (const bytes of [Buffer.from([65, 0, 66]), Buffer.from([255]), Buffer.alloc(256 * 1024 + 1, 65)]) {
    await writeFile(path, bytes);
    expect(await invokeRemoteFile("fs:readText", [path, 2 * 1024 * 1024], [project])).toBeNull();
  }
});

it("图片读取限制为普通文件和 10 MiB，边界内返回完整字节", async () => {
  const path = join(project, "image.png");
  const bytes = Buffer.alloc(10 * 1024 * 1024, 128);
  await writeFile(path, bytes);
  expect(await invokeRemoteFile("fs:readMedia", [path], [project])).toBe(bytes.toString("base64"));
  await writeFile(path, Buffer.alloc(bytes.length + 1));
  expect(await invokeRemoteFile("fs:readMedia", [path], [project])).toBeNull();
  expect(await invokeRemoteFile("fs:readMedia", [project], [project])).toBeNull();
});
