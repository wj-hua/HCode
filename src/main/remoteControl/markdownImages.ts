// 只识别正文图片链接；代码围栏保持原文，文件读取受真实路径、图片类型和大小约束。
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteReferenceNotFound } from "./signedReference.js";

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml" };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const INLINE_CODE = /(`+).*?\1(?!`)/g;
const IMAGE_LINK = /!\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^\)\n]+))\)/g;

export function mapMarkdownImages(text: string, map: (source: string) => string): string {
  let fence: string | undefined;
  return text.split("\n").map(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { fence = fence ? (marker.startsWith(fence[0]!) && marker.length >= fence.length ? undefined : fence) : marker; return line; }
    if (fence) return line;
    // 行内代码也是原文，避免把说明中的路径误当成真实图片引用。
    let result = "", start = 0;
    for (const code of line.matchAll(INLINE_CODE)) {
      result += mapImageLinks(line.slice(start, code.index), map) + code[0];
      start = code.index + code[0].length;
    }
    return result + mapImageLinks(line.slice(start), map);
  }).join("\n");
}

function mapImageLinks(line: string, map: (source: string) => string): string {
    return line.replace(IMAGE_LINK, (original, alt: string, angled: string | undefined, bare: string | undefined) => {
      const source = angled ?? bare!;
      if (!localImagePath(source)) return original;
      const mapped = map(source);
      return mapped === source ? original : `![${alt}](${mapped})`;
    });
}

function localImagePath(source: string): boolean {
  return !/^(https?:|data:|blob:)/i.test(source) && !!IMAGE_TYPES[extname(source).toLowerCase()];
}

/** 允许会话项目和系统临时产物中的图片；realpath 防止符号链接借用目录白名单。 */
export async function readMarkdownImage(source: string, projectPath?: string) {
  if (!localImagePath(source)) throw new RemoteReferenceNotFound();
  const decoded = source.startsWith("file:") ? fileURLToPath(source) : decodeURIComponent(source);
  const path = decoded.startsWith("~/") ? resolve(homedir(), decoded.slice(2)) : isAbsolute(decoded) ? decoded : projectPath ? resolve(projectPath, decoded) : undefined;
  if (!path) throw new RemoteReferenceNotFound();
  try {
    const file = await realpath(path);
    const roots = await Promise.all([...new Set([tmpdir(), "/tmp", ...(projectPath ? [projectPath] : [])])].map(async root => {
      try { return await realpath(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }));
    if (!roots.some(root => root !== undefined && file.startsWith(root + sep))) throw new RemoteReferenceNotFound();
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new RemoteReferenceNotFound("图片过大或不是普通文件");
    const body = await readFile(file);
    if (body.length > MAX_IMAGE_BYTES) throw new RemoteReferenceNotFound("图片超过 20 MiB");
    return { body, type: IMAGE_TYPES[extname(path).toLowerCase()]!, cacheControl: "private, no-cache" };
  } catch (error) {
    if (["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new RemoteReferenceNotFound("图片不存在或不可读取");
    throw error;
  }
}
