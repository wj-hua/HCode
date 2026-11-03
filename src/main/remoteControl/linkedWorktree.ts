// 仅在解析会话已引用的产物时查询 Git 注册的工作树；同名前缀目录不能取得权限。
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";

const git = promisify(execFile);

export function insideRoot(root: string, path: string): boolean {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

/** 路径和真实目标都必须在同一工作树内，拒绝通过链接访问其他工作树的文件。 */
export async function linkedArtifactRoot(project: string, path: string, file: string): Promise<string | undefined> {
  let output: string;
  try {
    output = (await git("git", ["-C", project, "worktree", "list", "--porcelain", "-z"], { timeout: 3000 })).stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as {code?: number}).code === 128) return undefined;
    throw error;
  }
  for (const field of output.split("\0")) {
    if (!field.startsWith("worktree ")) continue;
    const root = field.slice("worktree ".length);
    if (insideRoot(root, project)) continue;
    if (insideRoot(root, path) && insideRoot(await realpath(root), file)) return root;
  }
  return undefined;
}
