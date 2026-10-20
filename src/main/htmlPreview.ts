/** 以短期地址提供 HTML 和项目内资源；页面在无宿主权限的沙箱中运行。 */
import { randomUUID } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { HTML_PREVIEW_SCHEME, type HtmlPreviewLease } from "../shared/htmlPreview.js";
import { readTextFile } from "./readTextFile.js";

const MAX_HTML_BYTES = 256 * 1024;
const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".avif": "image/avif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};
const PREVIEW_CSP = [
  "default-src 'none'", "sandbox allow-scripts", "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https:", "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:", "connect-src 'none'", "frame-src 'none'",
  "object-src 'none'", "base-uri 'self'", "form-action 'none'",
].join("; ");

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

/** 读取量始终受限，文件在 stat 后增长也不会变成无限制读取。 */
async function readResource(path: string, limit: number): Promise<Buffer | null> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of file.createReadStream({ start: 0, end: limit, autoClose: false })) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    return bytes.length <= limit ? bytes : null;
  } finally { await file.close(); }
}

export class HtmlPreviewService {
  private readonly leases = new Map<string, { root: string }>();

  /** 只接受用户打开的有界 HTML；相对资源限制在所属项目，项目外文件限制在同目录。 */
  async create(path: string, workspacePath?: string): Promise<HtmlPreviewLease> {
    const file = await realpath(path);
    if (!/^\.html?$/i.test(extname(file))) throw new Error("该文件不是 HTML 页面");
    if (await readTextFile(file, MAX_HTML_BYTES) === null) throw new Error("HTML 无法读取、不是 UTF-8 文本或超过 256 KiB");
    const workspace = workspacePath ? await realpath(workspacePath) : dirname(file);
    const root = isInside(workspace, file) ? workspace : dirname(file);
    const id = randomUUID();
    this.leases.set(id, { root });
    const resource = relative(root, file).split(sep).map(encodeURIComponent).join("/");
    return { id, url: `${HTML_PREVIEW_SCHEME}://${id}/${resource}` };
  }

  /** 关闭、刷新或切换文件后立即撤销地址，页面不能继续访问项目资源。 */
  release(id: string): void { this.leases.delete(id); }

  /** 协议请求不接受任意本机路径；穿越与符号链接在读取前再次检查真实路径。 */
  async respond(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("仅允许读取预览资源", { status: 405 });
    const url = new URL(request.url);
    const lease = url.protocol === `${HTML_PREVIEW_SCHEME}:` ? this.leases.get(url.hostname) : undefined;
    if (!lease) return new Response("预览地址已失效，请刷新", { status: 404 });
    try { return await this.readResponse(url, lease.root, request.method === "HEAD"); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return new Response("预览资源不存在", { status: 404 });
      if (code === "EACCES" || code === "EPERM") return new Response("无权读取预览资源", { status: 403 });
      console.error("[HtmlPreview] 读取预览资源失败", error);
      return new Response("读取预览资源失败", { status: 500 });
    }
  }

  private async readResponse(url: URL, root: string, headOnly: boolean): Promise<Response> {
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return new Response("预览路径编码无效", { status: 400 }); }
    if (pathname.includes("\\") || pathname.includes("\0")) return new Response("预览路径无效", { status: 400 });
    const path = resolve(root, `.${pathname}`);
    if (!isInside(root, path)) return new Response("资源超出预览范围", { status: 403 });
    const file = await realpath(path);
    if (!isInside(root, file)) return new Response("资源超出预览范围", { status: 403 });
    const extension = extname(file).toLowerCase();
    const contentType = CONTENT_TYPES[extension];
    if (!contentType || !(await stat(file)).isFile()) return new Response("不支持的预览资源", { status: 403 });
    const bytes = await readResource(file, extension === ".html" || extension === ".htm" ? MAX_HTML_BYTES : MAX_RESOURCE_BYTES);
    if (!bytes) return new Response("预览资源超过大小限制", { status: 413 });
    return new Response(headOnly ? null : new Uint8Array(bytes), { headers: {
      "Content-Type": contentType, "Content-Security-Policy": PREVIEW_CSP,
      "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*", "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    } });
  }
}
