/** 远程文件预览只读已添加项目和系统临时产物；不开放桌面的任意路径读取能力。 */
import { open, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { readTextFile } from "../readTextFile.js";

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const FILE_CHANNELS = ["fs:stat", "fs:readText", "fs:readMedia"] as const;
type FileChannel = typeof FILE_CHANNELS[number];

export function isRemoteFileChannel(channel: string): channel is FileChannel {
  return FILE_CHANNELS.some(candidate => candidate === channel);
}

function isWithin(root: string, file: string): boolean {
  const child = relative(root, file);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

async function existingPath(path: string): Promise<string | null> {
  try { return await realpath(path); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

/** 每次读取重新核对真实路径；目录移除、路径穿越或符号链接都不能借用项目白名单。 */
async function allowedFile(path: unknown, projectPaths: string[]): Promise<string | null> {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error("文件预览需要有效的绝对路径");
  const file = await existingPath(path);
  if (!file) return null;
  const roots = await Promise.all([...new Set([...projectPaths, tmpdir(), "/tmp"])].map(existingPath));
  if (!roots.some(root => root !== null && isWithin(root, file))) throw new Error("文件超出远程预览范围，仅支持已添加项目和系统临时目录");
  return file;
}

/** 图片以 base64 穿过 JSON，浏览器恢复为字节；stat 后文件增长仍受硬上限约束。 */
async function readMedia(path: string): Promise<string | null> {
  const initial = await stat(path);
  if (!initial.isFile() || initial.size > MAX_MEDIA_BYTES) return null;
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_MEDIA_BYTES) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of file.createReadStream({ start: 0, end: MAX_MEDIA_BYTES, autoClose: false })) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    return bytes.length <= MAX_MEDIA_BYTES ? bytes.toString("base64") : null;
  } finally { await file.close(); }
}

/** 专用 HTTP 读取边界：保持桌面 fs 的空文件/无法预览语义，范围校验失败明确报错。 */
export async function invokeRemoteFile(channel: FileChannel, args: unknown[], projectPaths: string[]): Promise<unknown> {
  const file = await allowedFile(args[0], projectPaths);
  if (!file) return null;
  try {
    if (channel === "fs:stat") {
      const info = await stat(file);
      return { exists: true, isDirectory: info.isDirectory(), size: info.size };
    }
    if (channel === "fs:readMedia") return await readMedia(file);
    const maxBytes = args[1] ?? MAX_TEXT_BYTES;
    if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("文本预览字节上限无效");
    return await readTextFile(file, Math.min(maxBytes, MAX_TEXT_BYTES));
  } catch (error) {
    // 文件可能在路径校验后被清理；权限及其他 IO 错误不能伪装成“不存在”。
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}
