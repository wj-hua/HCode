// 删除会话时把文件移到废纸篓，误删可以从废纸篓恢复。
import { existsSync } from "node:fs";
import { shell } from "electron";

/** 把存在的路径移到废纸篓，返回实际移动的数量。 */
export async function trashPaths(paths: readonly string[]): Promise<number> {
  const existing = paths.filter((path) => existsSync(path));
  for (const path of existing) await shell.trashItem(path);
  return existing.length;
}
