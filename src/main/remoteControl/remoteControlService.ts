// 远程操控本地服务：只监听回环地址，经反向隧道对外。
// 提供界面静态文件、口令登录、白名单 invoke（POST /api/invoke）与事件推送（SSE /api/events），
// 以及供对接方服务器订阅的通知事件流（SSE /api/notifications/stream，独立订阅令牌）。
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import type { EventChannel, EventMap, InvokeChannel } from "../../shared/ipc.js";
import type { RemoteControlStatus, RemoteSessionSnapshot } from "../../shared/remoteControl.js";
import type { ChatStateEvent, ChatRowsEvent, ConversationRow, PermissionRequestEvent, RemoteControlSettings, SessionLoadResult, Settings } from "../../shared/types.js";
import { REMOTE_MEDIA_PATH } from "../../shared/remoteControl.js";
import { RemoteMedia, RemoteMediaNotFound, REMOTE_IMAGE_HEADERS, type RemoteImage, type RemoteMediaSource } from "./remoteMedia.js";
import { remoteHistoryPage } from "./historyPage.js";
import { RemoteEventClients } from "./eventClients.js";
import { compress, isCompressible, negotiateEncoding, type ContentEncoding } from "./httpCompression.js";
import { NotificationFeed } from "./notificationFeed.js";
import { checkRemoteInvoke, remoteSettings, REMOTE_EVENTS, type RemotePolicyContext } from "./policy.js";
import { REMOTE_SESSION_TTL_MS, type RemoteSessionStore } from "./sessionStore.js";
import type { RemoteTokenStore } from "./tokenStore.js";
import { ReverseTunnel, validateTunnelConfig } from "./tunnel.js";

const COOKIE = "hcode_remote";
const LOGIN_FAILURE_WINDOW_MS = 60_000;
const MAX_LOGIN_FAILURES = 5;
/** fs:stageAttachment 的 base64 上限为 28 MB，再留出 JSON 外壳。 */
const MAX_INVOKE_BYTES = 30 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;
/** 构建产物目录：文件名带内容哈希，内容变化必然换名，可让浏览器永久缓存。 */
const HASHED_ASSET_DIR = "assets";
const HASHED_ASSET_CACHE = "public, max-age=31536000, immutable";
const STATIC_CACHE = "public, max-age=3600";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export interface RemoteControlDeps {
  config(): RemoteControlSettings;
  tokens: RemoteTokenStore;
  /** 通知事件流的订阅令牌；只能读事件摘要，不能登录或调用 invoke。 */
  notificationTokens: RemoteTokenStore;
  /** 登录会话；跨重启保留，关闭开关或重新生成口令时清除。 */
  sessions: RemoteSessionStore;
  policy: RemotePolicyContext;
  /** 调用 handle() 注册的同一个 handler。 */
  invoke(channel: InvokeChannel, args: unknown[]): Promise<unknown>;
  liveRows(sessionKey: string): ConversationRow[] | undefined;
  hasSession(sessionKey: string): boolean;
  /** 从主进程会话元数据读取通知标题，不访问对话正文。 */
  sessionTitle?(state: ChatStateEvent): Promise<string | undefined>;
  /** 渲染进程构建产物目录。 */
  staticDir: string;
  /** ssh 进程的环境变量。 */
  env(): Record<string, string>;
  onStatus(status: RemoteControlStatus): void;
  thumbnail?(image: RemoteImage): RemoteImage;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class RemoteControlService {
  private server: Server | null = null;
  private port = 0;
  private status: RemoteControlStatus = { state: "off", clients: 0, notificationSubscribers: 0, tunnel: { state: "off" } };
  private readonly tunnel: ReverseTunnel;
  private seq = 0;
  private readonly clients = new RemoteEventClients(() => this.updateClients());
  private loginFailures: number[] = [];
  private heartbeat: NodeJS.Timeout | null = null;
  private applying: Promise<void> = Promise.resolve();
  // 中途接入的远程客户端需要的状态；不论开关是否打开都跟踪，开启后立即可用。
  private readonly states = new Map<string, ChatStateEvent>();
  private readonly permissions = new Map<string, PermissionRequestEvent>();
  private readonly feed: NotificationFeed;
  private readonly media: RemoteMedia;
  /** 带哈希构建产物的压缩结果，键为“路径 + 编码”；内容不变，进程内缓存即可。 */
  private readonly compressedAssets = new Map<string, Promise<Buffer>>();

  constructor(private readonly deps: RemoteControlDeps) {
    this.media = new RemoteMedia(source => this.mediaRows(source));
    this.feed = new NotificationFeed(Date.now, deps.sessionTitle);
    this.tunnel = new ReverseTunnel(deps.env, (tunnel) => this.setStatus({ tunnel }));
  }

  getStatus(): RemoteControlStatus {
    return this.status;
  }

  sessionState(sessionKey: string): ChatStateEvent | undefined {
    return this.states.get(sessionKey);
  }

  /** 按当前设置启动、重启或关闭服务。 */
  apply(): Promise<void> {
    this.applying = this.applying.then(() => this.applyNow()).catch(() => {});
    return this.applying;
  }

  regenerateToken(): string {
    const token = this.deps.tokens.regenerate();
    this.deps.sessions.clear();
    this.disconnectClients();
    return token;
  }

  regenerateNotificationToken(): string {
    const token = this.deps.notificationTokens.regenerate();
    this.feed.disconnectAll();
    this.updateSubscribers();
    return token;
  }

  /** 由 send() 调用：先更新跟踪状态，再推给在线的远程客户端。 */
  publish<C extends EventChannel>(channel: C, payload: EventMap[C]) {
    if (channel === "chat:state") {
      const event = payload as ChatStateEvent;
      this.states.set(event.sessionKey, event);
    } else if (channel === "permission:requested") {
      const event = payload as PermissionRequestEvent;
      this.permissions.set(event.interactionId, event);
    } else if (channel === "permission:resolved") {
      this.permissions.delete((payload as EventMap["permission:resolved"]).interactionId);
    }
    this.feed.observe(channel, payload);
    if (!this.server || this.clients.size === 0 || !REMOTE_EVENTS.has(channel)) return;
    const outgoing = channel === "chat:rows" ? this.mediaEvent(payload as ChatRowsEvent) : payload;
    this.clients.publish(channel, outgoing as EventMap[C], ++this.seq);
  }

  dispose() {
    this.stop();
  }

  reconnect() {
    this.tunnel.reconnect();
  }

  private async applyNow() {
    const config = this.deps.config();
    if (!config.enabled) {
      this.stop();
      this.deps.sessions.clear();
      return;
    }
    if (!config.notificationFeed) {
      this.feed.disconnectAll();
      this.updateSubscribers();
    }
    if (!this.server || (config.localPort !== 0 && config.localPort !== this.port)) await this.listen(config);
    if (!this.server) return;
    if (!config.sshHost && !config.remoteBind) {
      this.tunnel.stop();
      return;
    }
    const invalid = validateTunnelConfig(config.sshHost, config.remoteBind);
    if (invalid) {
      this.tunnel.stop();
      this.setStatus({ tunnel: { state: "error", error: invalid } });
      return;
    }
    this.tunnel.start({ sshHost: config.sshHost, remoteBind: config.remoteBind, localPort: this.port });
  }

  private async listen(config: RemoteControlSettings) {
    this.stop();
    this.setStatus({ state: "starting", clients: 0, error: undefined });
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500;
        if (!res.headersSent) sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
        else res.destroy();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.localPort, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      server.close();
      this.setStatus({ state: "error", error: `本地服务启动失败：${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    this.heartbeat = setInterval(() => {
      this.clients.ping();
      this.feed.ping();
    }, HEARTBEAT_MS);
    this.setStatus({ state: "listening", port: this.port, error: undefined });
  }

  private stop() {
    this.tunnel.stop();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.disconnectClients();
    this.feed.disconnectAll();
    this.updateSubscribers();
    if (this.server) {
      this.server.close();
      this.server.closeAllConnections();
      this.server = null;
      this.port = 0;
    }
    if (this.status.state !== "off") this.setStatus({ state: "off", port: undefined, clients: 0, notificationSubscribers: 0, error: undefined });
  }

  private disconnectClients() {
    this.clients.disconnect();
  }

  private setStatus(patch: Partial<RemoteControlStatus>) {
    this.status = { ...this.status, ...patch };
    this.deps.onStatus(this.status);
  }

  private updateClients() {
    if (this.status.clients !== this.clients.size) this.setStatus({ clients: this.clients.size });
  }

  private updateSubscribers() {
    const count = this.feed.subscriberCount;
    if (this.status.notificationSubscribers !== count) this.setStatus({ notificationSubscribers: count });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!pathname.startsWith("/api/")) return this.serveStatic(req, res, pathname);
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET" && pathname === "/api/notifications/stream") return this.openNotificationStream(req, res);
    if (req.method === "POST" && pathname === "/api/login") return this.login(req, res);
    if (req.method === "POST" && pathname === "/api/logout") {
      const sid = sessionCookie(req);
      if (sid) this.deps.sessions.revoke(sid);
      res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=${cookiePath(req)}; Max-Age=0`);
      return sendJson(res, 200, { ok: true });
    }
    if (!this.authorized(req)) throw new HttpError(401, "需要登录");
    if (pathname.startsWith(`/${REMOTE_MEDIA_PATH}`)) return this.serveMedia(req, res, pathname);
    if (req.method === "GET" && pathname === "/api/events") return this.openEvents(req, res);
    if (req.method === "POST" && pathname === "/api/invoke") return this.invoke(req, res);
    throw new HttpError(404, "Not found");
  }

  /**
   * 只接受未经反向代理的直连请求（对接方服务器经 SSH 隧道直连本地端口），
   * 带 X-Forwarded-* 的请求来自公网代理，一律按不存在处理；订阅令牌与登录口令、Cookie 互不通用。
   */
  private openNotificationStream(req: IncomingMessage, res: ServerResponse) {
    const forwarded = Object.keys(req.headers).some((name) => name.startsWith("x-forwarded-"));
    if (!this.deps.config().notificationFeed || forwarded) throw new HttpError(404, "Not found");
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!match || !this.deps.notificationTokens.matches(match[1]!)) throw new HttpError(401, "订阅令牌无效");
    const lastEventId = req.headers["last-event-id"];
    this.feed.attach(res, typeof lastEventId === "string" ? lastEventId : undefined, () => this.updateSubscribers());
  }

  private async login(req: IncomingMessage, res: ServerResponse) {
    requireRemoteHeader(req);
    const now = Date.now();
    this.loginFailures = this.loginFailures.filter((at) => now - at < LOGIN_FAILURE_WINDOW_MS);
    if (this.loginFailures.length >= MAX_LOGIN_FAILURES) throw new HttpError(429, "尝试次数过多，请稍后再试");
    const body = await readJson(req, 4096) as { token?: unknown };
    if (typeof body.token !== "string" || !this.deps.tokens.matches(body.token)) {
      this.loginFailures.push(now);
      throw new HttpError(401, "口令错误");
    }
    const sid = this.deps.sessions.create(now);
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=${cookiePath(req)}; Max-Age=${REMOTE_SESSION_TTL_MS / 1000}${secure}`);
    sendJson(res, 200, { ok: true });
  }

  private authorized(req: IncomingMessage): boolean {
    const sid = sessionCookie(req);
    return sid !== undefined && this.deps.sessions.isValid(sid);
  }

  private openEvents(req: IncomingMessage, res: ServerResponse) {
    this.clients.open(req, res, { seq: this.seq, permissions: [...this.permissions.values()] });
  }

  private async invoke(req: IncomingMessage, res: ServerResponse) {
    requireRemoteHeader(req);
    const body = await readJson(req, MAX_INVOKE_BYTES) as { channel?: unknown; args?: unknown };
    const channel = typeof body.channel === "string" ? body.channel : "";
    const args = Array.isArray(body.args) ? body.args : [];
    try {
      await sendCompressedJson(req, res, { ok: true, result: await this.dispatch(channel, args) });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async dispatch(channel: string, args: unknown[]): Promise<unknown> {
    if (channel === "sessions:page") {
      if (!checkRemoteInvoke(this.deps.policy, "sessions:load", [args[0]])) throw new HttpError(403, "远程不能读取该会话");
      const ref = args[0] as import("../../shared/types.js").SessionRef;
      const result = await this.deps.invoke("sessions:load", [ref]) as SessionLoadResult;
      const page = remoteHistoryPage(result, ref, args[1] == null ? undefined : args[1] as number);
      return { ...page, rows: this.media.mapRows(page.rows, { ref }) };
    }
    if (channel === "chat:live") {
      return [...this.states.values()].filter((event) => this.deps.hasSession(event.sessionKey));
    }
    if (channel === "chat:snapshot") return this.snapshot(String(args[0] ?? ""));
    if (!checkRemoteInvoke(this.deps.policy, channel, args)) throw new HttpError(403, `远程不能调用：${channel}`);
    const result = await this.deps.invoke(channel, args);
    if (channel === "sessions:load") {
      const history = result as SessionLoadResult;
      return { ...history, rows: this.media.mapRows(history.rows, { ref: args[0] as import("../../shared/types.js").SessionRef }) };
    }
    return channel === "settings:get" ? remoteSettings(result as Settings) : result;
  }

  private snapshot(sessionKey: string): RemoteSessionSnapshot | null {
    // liveRows 会同步发出缓冲中的增量，因此取完行再读 seq。
    const rows = this.deps.liveRows(sessionKey);
    if (!rows) return null;
    const page = this.livePage(sessionKey, rows);
    return {
      seq: this.seq,
      ...page,
      rows: this.media.mapRows(page.rows, { sessionKey }),
      state: this.states.get(sessionKey) ?? null,
      permissions: [...this.permissions.values()].filter((event) => event.sessionKey === sessionKey),
    };
  }

  private mediaEvent(event: ChatRowsEvent): ChatRowsEvent {
    const source = { sessionKey: event.sessionKey };
    const reset = event.ops.find(op => op.op === "reset");
    const page = reset?.op === "reset" ? this.livePage(event.sessionKey, reset.rows) : undefined;
    return { ...event, ...(page?.earlierRows ? { earlierRows: page.earlierRows } : {}), ops: event.ops.map(op => op.op === "reset" ? { ...op, rows: this.media.mapRows(page!.rows, source) }
      : op.op === "upsert" ? { ...op, row: this.media.mapRow(op.row, source) } : op) };
  }

  private livePage(sessionKey: string, rows: ConversationRow[]): Pick<SessionLoadResult, "rows" | "earlierRows"> {
    const state = this.states.get(sessionKey);
    if (!state?.sessionId) return { rows };
    const ref = { agent: state.agent, id: state.sessionId, projectPath: state.projectPath };
    const page = remoteHistoryPage({ summary: null, rows }, ref);
    return { rows: page.rows, ...(page.earlierRows ? { earlierRows: page.earlierRows } : {}) };
  }

  private async mediaRows(source: RemoteMediaSource): Promise<readonly ConversationRow[]> {
    if ("sessionKey" in source) return this.deps.liveRows(source.sessionKey) ?? [];
    // 项目移除后，已签发的图片地址也必须失效；不向客户端透露原路径。
    if (!this.deps.policy.projectPaths().includes(source.ref.projectPath)) throw new RemoteMediaNotFound();
    if (!checkRemoteInvoke(this.deps.policy, "sessions:load", [source.ref])) throw new RemoteMediaNotFound();
    return (await this.deps.invoke("sessions:load", [source.ref]) as SessionLoadResult).rows;
  }

  private async serveMedia(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    let image: RemoteImage;
    try { image = await this.media.read(pathname.slice(REMOTE_MEDIA_PATH.length + 1)); }
    catch (error) {
      if (error instanceof RemoteMediaNotFound) throw new HttpError(error.status, error.message);
      throw error;
    }
    const thumbnail = new URL(req.url!, "http://localhost").searchParams.has("thumbnail");
    if (thumbnail && this.deps.thumbnail) image = this.deps.thumbnail(image);
    res.writeHead(200, { ...REMOTE_IMAGE_HEADERS, "Content-Type": image.type, "Content-Length": image.body.length });
    res.end(req.method === "HEAD" ? undefined : image.body);
  }

  private async serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    const root = normalize(this.deps.staticDir) + sep;
    let relative: string;
    try {
      relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    } catch {
      throw new HttpError(400, "Bad path");
    }
    const path = normalize(join(root, relative));
    if (!path.startsWith(root)) throw new HttpError(404, "Not found");
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch {
      throw new HttpError(404, "Not found");
    }
    const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    const hashed = path.startsWith(join(root, HASHED_ASSET_DIR) + sep);
    const cacheControl = type.startsWith("text/html") ? "no-store" : hashed ? HASHED_ASSET_CACHE : STATIC_CACHE;
    const compressible = isCompressible(type, data.length);
    const encoding = compressible ? negotiateEncoding(req.headers["accept-encoding"]) : null;
    const body = encoding ? await this.compressStatic(path, data, encoding, hashed) : data;
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": body.length,
      "Cache-Control": cacheControl,
      ...(compressible ? { Vary: "Accept-Encoding" } : {}),
      ...(encoding ? { "Content-Encoding": encoding } : {}),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  /** 只缓存带哈希的产物；index.html 等可能随构建变化的文件每次现场压缩。 */
  private compressStatic(path: string, data: Buffer, encoding: ContentEncoding, hashed: boolean): Promise<Buffer> {
    if (!hashed) return compress(data, encoding, "dynamic");
    const key = `${path}\0${encoding}`;
    let pending = this.compressedAssets.get(key);
    if (!pending) {
      pending = compress(data, encoding, "static");
      this.compressedAssets.set(key, pending);
      // 压缩失败不能留在缓存里，否则该文件之后每次都失败。
      pending.catch(() => this.compressedAssets.delete(key));
    }
    return pending;
  }
}

/** 经 nginx 子路径访问时，Cookie 只发给该路径，不带给同域名下的其他服务。 */
function cookiePath(req: IncomingMessage): string {
  const prefix = req.headers["x-forwarded-prefix"];
  return typeof prefix === "string" && /^\/[A-Za-z0-9._/-]*$/.test(prefix) ? `${prefix.replace(/\/+$/, "")}/` : "/";
}

function sessionCookie(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return undefined;
}

/** 跨站表单无法附带自定义请求头，配合 SameSite Cookie 防止 CSRF。 */
function requireRemoteHeader(req: IncomingMessage) {
  if (req.headers["x-hcode-remote"] !== "1") throw new HttpError(403, "缺少请求头");
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "请求过大");
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object") throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "请求格式错误");
  }
}

/** invoke 结果可能是整段对话快照，按客户端支持的编码压缩后发送。 */
async function sendCompressedJson(req: IncomingMessage, res: ServerResponse, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  const type = "application/json; charset=utf-8";
  const encoding = isCompressible(type, body.length) ? negotiateEncoding(req.headers["accept-encoding"]) : null;
  const payload = encoding ? await compress(body, encoding, "dynamic") : body;
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": payload.length,
    Vary: "Accept-Encoding",
    ...(encoding ? { "Content-Encoding": encoding } : {}),
  });
  res.end(payload);
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
