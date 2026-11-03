// 登录后签发有期限的页面地址，绑定登录会话；每次取资源时重验项目归属与真实路径。
import { collectHtmlAssets } from "./htmlAssetReferences.js";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { HTML_PREVIEW_SCHEME } from "../../shared/htmlPreview.js";
import type { RemoteRowSource } from "../../shared/remoteControl.js";
import { HtmlPreviewService } from "../htmlPreview.js";
import { allowedFile } from "./filePreview.js";
import { insideRoot, linkedArtifactRoot } from "./linkedWorktree.js";

export const HTML_RESOURCE_PATH = "api/html-preview/";
const LEASE_LIFETIME = 30 * 60_000;
const MAX_LEASES = 64;
type Lease = { assets: Set<string>; session: string; project: string; expires: number; root: string; entry: string; linked: boolean };

export class RemoteHtmlPreview {
  private readonly pages = new HtmlPreviewService();
  private readonly leases = new Map<string, Lease>();

  constructor(private readonly projects: () => string[],
    private readonly linkedInReply: (source: RemoteRowSource, rowId: number, path: string) => Promise<boolean>) {}

  /** 随机预览地址只为已登录页面实际声明的资源授予读取权；主会话撤销后随即失效。 */
  assetSession(resource: string): string | undefined {
    const slash = resource.indexOf("/");
    const lease = this.leases.get(resource.slice(0, slash));
    return lease && lease.expires > Date.now() && lease.assets.has(resource.slice(slash)) ? lease.session : undefined;
  }

  async create(args: unknown[], session: string) {
    const [path, project, proof] = args;
    if (typeof project !== "string" || !this.projects().includes(project) || typeof path !== "string" ||
        !path.startsWith("/") || !/\.html?$/i.test(path)) throw new Error("仅支持已添加项目中的 HTML 页面");
    const file = await realpath(path);
    const projectRoot = await realpath(project);
    const inTree = insideRoot(projectRoot, file);
    let linkedRoot: string | undefined;
    if (!inTree && proof && typeof proof === "object" && "source" in proof && "rowId" in proof) {
      if (!proof.source || typeof proof.source !== "object") throw new Error("无效的会话引用");
      const source = proof.source as RemoteRowSource;
      const origin = "ref" in source ? source.ref.projectPath : source.projectPath;
      if (origin === project && typeof proof.rowId === "number" && await this.linkedInReply(source, proof.rowId, path)) {
        linkedRoot = await linkedArtifactRoot(project, path, file);
      }
    }
    if (!linkedRoot && !await allowedFile(file, this.projects())) throw new Error("HTML 文件不存在");
    const root = linkedRoot ?? (inTree ? projectRoot : dirname(file));
    const lease = await this.pages.create(file, root);
    this.leases.set(lease.id, { session, project, root, linked: !!linkedRoot, assets: new Set(),
      entry: file, expires: Date.now() + LEASE_LIFETIME });
    for (const [id, item] of this.leases) {
      if (item.expires <= Date.now() || this.leases.size > MAX_LEASES) this.drop(id);
    }
    return { id: lease.id, url: HTML_RESOURCE_PATH + lease.id + new URL(lease.url).pathname };
  }

  release(id: unknown, session: string) {
    if (typeof id === "string" && this.leases.get(id)?.session === session) this.drop(id);
  }

  clear() { for (const id of this.leases.keys()) this.drop(id); }
  private drop(id: string) { this.pages.release(id); this.leases.delete(id); }

  async read(resource: string, method: string, session: string, assetOnly: boolean) {
    const slash = resource.indexOf("/");
    const id = resource.slice(0, slash);
    const lease = this.leases.get(id);
    if (!lease || lease.session !== session || lease.expires <= Date.now() || !this.projects().includes(lease.project)) {
      return new Response("预览已过期，请刷新", { status: 404 });
    }
    const url = new URL(`${HTML_PREVIEW_SCHEME}://${id}${resource.slice(slash)}`);
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return new Response("资源地址编码无效", { status: 400 }); }
    const path = resolve(lease.root, "." + pathname);
    if (!insideRoot(lease.root, path)) return new Response(null, { status: 403 });
    if (lease.linked) {
      const file = await realpath(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      });
      // 同一工作树里也不能借已授权的资源名改读另一个文件。
      if (!file || file !== path || !insideRoot(lease.root, file)) return new Response(null, { status: 403 });
      if (file !== lease.entry && (!lease.assets.has(url.pathname) || /\.html?$/i.test(file))) return new Response(null, { status: 403 });
      if (!await linkedArtifactRoot(lease.project, lease.entry, lease.entry)) return new Response(null, { status: 403 });
    } else if (!await allowedFile(path, this.projects())) return new Response(null, { status: 404 });
    const response = await this.pages.respond(new Request(url, { method }));
    // 不能用静态资源的地址通过符号链接打开另一个 HTML 文档。
    if (assetOnly && response.headers.get("Content-Type")?.startsWith("text/html")) return new Response(null, { status: 403 });
    if (method === "GET" && response.ok && /^(text\/html|text\/css|text\/javascript)/.test(response.headers.get("Content-Type") ?? "")) {
      collectHtmlAssets(await response.clone().text(), url, lease.assets);
    }
    return response;
  }
}
