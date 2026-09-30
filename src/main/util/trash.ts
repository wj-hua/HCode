// 删除会话时把文件移到废纸篓，误删可以从废纸篓恢复。
import { lstat } from "node:fs/promises";
import { shell } from "electron";

/** 把存在的路径移到废纸篓，返回实际移动的数量。 */
export async function trashPaths(paths: readonly string[]): Promise<number> {
  // lstat 也能识别目标已不存在的符号链接，撤销新建链接时仍应移到废纸篓。
  const present = await Promise.all(paths.map(async (path) => {
    try { await lstat(path); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }));
  const existing = paths.filter((_, index) => present[index]);
  for (const path of existing) await shell.trashItem(path);
  return existing.length;
}
