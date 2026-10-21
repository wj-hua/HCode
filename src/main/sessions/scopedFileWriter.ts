// 宿主拥有文本写入权限；原生 AI 仅持有受限读权限。路径、版本和活动租约均在实际写入边界检查。
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CODE_WORKSPACE_LIMITS, type ScopedWriteFeedback } from '../../shared/codeDelivery.js';
import { hashBytes, inside } from '../collaboration/workspaces/fileManifest.js';
import type { HostedTool } from './researchRuntime.js';

const scopedTools = new WeakSet<HostedTool>();
export const isScopedWriteTool = (tool: HostedTool) => scopedTools.has(tool);

class ScopedWriteError extends Error {
  constructor(readonly feedback: ScopedWriteFeedback) { super(JSON.stringify(feedback)); }
}
function writeFailure(code: string, path: string, error: string) {
  return new ScopedWriteError({ code, path, error, guidance: '将此反馈交回主 AI，调整提示词和文件分工；需要新增文件权限时重新派发，不要绕过宿主工具。文件 hash 变化时先重新读取并核对内容，不得盲目覆盖。' });
}

export class ScopedFileWriter {
  private readonly busy = new Set<string>();
  constructor(private readonly root: string, private readonly assertActive: () => void, private readonly allowedPaths?: readonly string[], private readonly onFeedback?: (feedback: ScopedWriteFeedback) => Promise<void>) {}

  /** 文件清单不能指向目录、链接或大小写别名；新文件允许尚未存在。 */
  async validate() {
    for (const path of this.allowedPaths ?? []) {
      const target = await this.writePath(path);
      const info = await this.optionalStat(target);
      if (info && !info.isFile()) throw writeFailure('invalid_write_path', path, '文件范围必须是普通文件');
    }
  }

  private async writePath(input: string) {
    const path = resolve(this.root, input);
    if (input.split('/').includes('node_modules')) throw writeFailure('write_scope_violation', input, '依赖目录不开放模型写入');
    if (!input || !inside(this.root, path) || path === this.root || input.split('/').includes('.git')) {
      throw writeFailure('write_scope_violation', input, '写入路径超出授权范围');
    }
    if (await realpath(this.root) !== this.root) throw writeFailure('invalid_write_root', input, '写入根目录已变为链接或别名');
    let ancestor = this.root;
    for (const part of path.slice(this.root.length + 1).split('/')) {
      ancestor = join(ancestor, part);
      const info = await this.optionalStat(ancestor);
      if (info?.isSymbolicLink() || info && await realpath(ancestor) !== ancestor) throw writeFailure('write_scope_violation', input, '写入路径含符号链接或大小写别名');
      if (ancestor !== path && info && !info.isDirectory()) throw writeFailure('invalid_write_path', input, '写入路径祖先不是目录');
    }
    return path;
  }

  private async optionalStat(path: string) {
    try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  async fileHash(input: string): Promise<string | null> {
    const path = await this.writePath(input);
    return await this.optionalStat(path) ? hashBytes(await readFile(path)) : null;
  }

  /** 同路径并发请求不允许同时通过旧 hash 校验；每次副作用前重核对活动租约。 */
  private async change(input: Record<string, unknown>, remove: boolean) {
    const path = String(input.path);
    this.assertActive();
    let acquired = false;
    try {
      if (this.allowedPaths && !this.allowedPaths.includes(path)) throw writeFailure('write_scope_violation', path, '写入路径超出任务授权范围');
      if (this.busy.has(path)) throw writeFailure('write_in_progress', path, '同一文件已有写入请求，请等待完成后重新读取');
      this.busy.add(path); acquired = true;
      const target = await this.writePath(path);
      if (await this.fileHash(path) !== input.expectedHash || remove && input.expectedHash === null) throw writeFailure('file_version_changed', path, '文件 hash 已变化，需重新读取');
      this.assertActive();
      if (remove) { await rm(target); return { deleted: path }; }
      return await this.write(target, path, String(input.content), input.expectedHash);
    } catch (error) {
      if (error instanceof ScopedWriteError) await this.onFeedback?.(error.feedback);
      throw error;
    } finally { if (acquired) this.busy.delete(path); }
  }

  private async write(target: string, path: string, content: string, expectedHash: unknown) {
    if (Buffer.byteLength(content) > CODE_WORKSPACE_LIMITS.maxWriteBytes) throw new Error('写入内容超过 256 KiB');
    const info = await this.optionalStat(target);
    await mkdir(resolve(target, '..'), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: info ? info.mode & 0o777 : 0o644 });
    try {
      this.assertActive();
      await this.writePath(path);
      if (await this.fileHash(path) !== expectedHash) throw writeFailure('file_version_changed', path, '文件 hash 已变化，需重新读取');
      await rename(temporary, target);
      return { path, hash: hashBytes(content) };
    } finally { await rm(temporary, { force: true }); }
  }

  tools(): HostedTool[] {
    const common = { path: z.string().min(1), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable() };
    const tools: HostedTool[] = [
      { name: 'write_file', description: '仅在宿主授权文件范围内写入完整文本。expectedHash 来自 read_file；新文件为 null。不能写依赖、Git 或链接；越界和 hash 冲突会返回调整分工的反馈。', schema: { ...common, content: z.string().max(CODE_WORKSPACE_LIMITS.maxWriteBytes) }, execute: input => this.change(input, false) },
      { name: 'delete_file', description: '仅删除宿主授权范围内且 hash 匹配的单个文件；不支持递归目录删除。', schema: common, execute: input => this.change(input, true) },
    ];
    for (const tool of tools) scopedTools.add(tool);
    return tools;
  }
}
