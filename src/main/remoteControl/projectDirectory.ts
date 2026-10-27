import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProjectDirectoryListing } from "../../shared/ipc.js";

/** 只返回目录，供已登录的远程客户端选择宿主机项目。 */
export async function browseProjectDirectories(input: unknown, showHidden: unknown): Promise<ProjectDirectoryListing> {
  if ((input !== null && (typeof input !== "string" || !input.trim() || !isAbsolute(input.trim()))) || typeof showHidden !== "boolean") {
    throw new Error("请输入电脑上的绝对目录路径");
  }
  const path = resolve(input === null ? homedir() : (input as string).trim());
  const entries = await readdir(path, { withFileTypes: true });
  const directories = await Promise.all(entries
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .map(async (entry) => {
      const entryPath = join(path, entry.name);
      const isSymbolicLink = entry.isSymbolicLink();
      // 跟随指向文件夹的符号链接；失效或不可访问的链接不能作为目录打开。
      const isDirectory = entry.isDirectory() || (isSymbolicLink && await stat(entryPath).then((info) => info.isDirectory()).catch(() => false));
      return isDirectory ? { name: entry.name, path: entryPath, isSymbolicLink } : null;
    }));
  const parent = dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    directories: directories.filter((entry) => entry !== null).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })),
  };
}

/** 路径属于运行 HCode 的宿主机；创建只允许新增最后一级目录。 */
export async function prepareProjectDirectory(input: unknown, create: unknown, conversationPath: string): Promise<string> {
  if (typeof input !== "string" || !input.trim() || !isAbsolute(input.trim()) || typeof create !== "boolean") throw new Error("请输入电脑上的绝对目录路径");
  const path = resolve(input.trim());
  if (path === conversationPath) throw new Error("对话目录不能作为项目添加");
  if (create) await mkdir(path);
  if (!(await stat(path)).isDirectory()) throw new Error("路径不是文件夹");
  return path;
}
