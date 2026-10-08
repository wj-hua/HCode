import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readTextFile } from "../readTextFile.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(content: string | Uint8Array) {
  const dir = await mkdtemp(join(tmpdir(), "hcode-preview-"));
  directories.push(dir);
  const path = join(dir, "文件.ts");
  await writeFile(path, content);
  return { dir, path };
}

it("预览 UTF-8 源码、BOM、换行和空文件", async () => {
  const content = 'const name = "你好";\r\n\tconsole.log(name);\n';
  const { path } = await fixture(`\uFEFF${content}`);
  expect(await readTextFile(path)).toBe(content);
  await writeFile(path, "");
  expect(await readTextFile(path, 0)).toBe("");
});

it("按字节限制读取；调用者无法提高主进程的硬上限", async () => {
  const { path } = await fixture("你好");
  expect(await readTextFile(path, 6)).toBe("你好");
  expect(await readTextFile(path, 5)).toBeNull();
  await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  expect(await readTextFile(path, 10 * 1024 * 1024)).toBeNull();
  expect(await readTextFile(path, -1)).toBeNull();
  expect(await readTextFile(path, Infinity)).toBeNull();
});

it("拒绝包含 NUL 的二进制和无效 UTF-8，保留正文里的替换字符", async () => {
  const { path } = await fixture(Buffer.from([65, 0, 66]));
  expect(await readTextFile(path)).toBeNull();
  await writeFile(path, Buffer.from([0xff, 0xfe, 65]));
  expect(await readTextFile(path)).toBeNull();
  await writeFile(path, "字符 �");
  expect(await readTextFile(path)).toBe("字符 �");
});

it("目录和不存在的文件无法预览", async () => {
  const { dir } = await fixture("");
  expect(await readTextFile(dir)).toBeNull();
  expect(await readTextFile(join(dir, "missing"))).toBeNull();
});
