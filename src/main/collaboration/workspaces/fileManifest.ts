// 全目录内容清单包含 ignored 依赖、二进制、链接和权限；仅 Git 管理目录不属于候选文件。
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { CODE_WORKSPACE_LIMITS } from '../../../shared/codeDelivery.js';
export interface FileEntry { path: string; hash: string; mode: number; bytes: number; binary: boolean; link?: string }
export interface FileManifest { hash: string; entries: FileEntry[]; bytes: number }
export function hashBytes(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
export function inside(root: string, path: string) { const child = relative(root, path); return child !== '..' && !child.startsWith('../') && !isAbsolute(child); }
/** 逐项检查而不跟随目录链接；外部链接/特殊文件不能进入可写副本。 */
export async function manifest(root: string): Promise<FileManifest> {
  const canonical = await realpath(root);
  const entries: FileEntry[] = [];
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      if (name === '.git') continue;
      const path = join(directory, name), info = await lstat(path);
      if (info.isDirectory()) { await walk(path); continue; }
      const entryPath = relative(canonical, path);
      if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`工作区不支持特殊文件：${entryPath}`);
      if (entries.length >= CODE_WORKSPACE_LIMITS.maxFiles || bytes + info.size > CODE_WORKSPACE_LIMITS.maxBytes) throw new Error('工作区超过 10 万文件或 4 GiB 准入限制');
      if (info.isSymbolicLink()) {
        const link = await readlink(path);
        if (isAbsolute(link) || !inside(canonical, await realpath(path))) throw new Error(`工作区存在外部或绝对依赖链接：${entryPath}`);
        entries.push({ path: entryPath, hash: hashBytes(link), mode: info.mode & 0o777, bytes: info.size, binary: false, link });
      } else {
        const content = await readFile(path);
        entries.push({ path: entryPath, hash: hashBytes(content), mode: info.mode & 0o777, bytes: content.length, binary: content.includes(0) || !isUtf8(content) });
      }
      bytes += info.size;
      if (entries.length > CODE_WORKSPACE_LIMITS.maxFiles || bytes > CODE_WORKSPACE_LIMITS.maxBytes) throw new Error('工作区超过 10 万文件或 4 GiB 准入限制');
    }
  };
  await walk(canonical);
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return { hash: hashBytes(JSON.stringify(entries)), entries, bytes };
}
function isUtf8(bytes: Buffer) { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; } }
