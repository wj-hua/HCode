// 远程操控本地服务：只监听回环地址，经反向隧道对外。
// 提供界面静态文件、口令登录、白名单 invoke（POST /api/invoke）与事件推送（SSE /api/events）。
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import type { EventChannel, EventMap, InvokeChannel } from "../../shared/ipc.js";
import type { RemoteControlStatus, RemoteSessionSnapshot } from "../../shared/remoteControl.js";
import type { ChatStateEvent, ConversationRow, PermissionRequestEvent, RemoteControlSettings, Settings } from "../../shared/types.js";
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
/** 客户端读取太慢时断开，由它重连后重新取快照。 */
const MAX_PENDING_EVENT_BYTES = 8 * 1024 * 1024;

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
  /** 登录会话；跨重启保留，关闭开关或重新生成口令时清除。 */
  sessions: RemoteSessionStore;
  policy: RemotePolicyContext;
  /** 调用 handle() 注册的同一个 handler。 */
  invoke(channel: InvokeChannel, args: unknown[]): Promise<unknown>;
  liveRows(sessionKey: string): ConversationRow[] | undefined;
  hasSession(sessionKey: string): boolean;
  /** 渲染进程构建产物目录。 */
  staticDir: string;
  /** ssh 进程的环境变量。 */
  env(): Record<string, string>;
  onStatus(status: RemoteControlStatus): void;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class RemoteControlService {
  private server: Server | null = null;
  private port = 0;
  private status: RemoteControlStatus = { state: "off", clients: 0, tunnel: { state: "off" } };
  private readonly tunnel: ReverseTunnel;
  private seq = 0;
  private readonly clients = new Set<ServerResponse>();
  private loginFailures: number[] = [];
  private heartbeat: NodeJS.Timeout | null = null;
  private applying: Promise<void> = Promise.resolve();
  // 中途接入的远程客户端需要的状态；不论开关是否打开都跟踪，开启后立即可用。
  private readonly states = new Map<string, ChatStateEvent>();
  private readonly permissions = new Map<string, PermissionRequestEvent>();

  constructor(private readonly deps: RemoteControlDeps) {
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
    if (!this.server || this.clients.size === 0 || !REMOTE_EVENTS.has(channel)) return;
    const frame = `id: ${++this.seq}\nevent: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      if (client.writableLength > MAX_PENDING_EVENT_BYTES) client.destroy();
      else client.write(frame);
    }
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
      for (const client of this.clients) client.write(": ping\n\n");
    }, HEARTBEAT_MS);
    this.setStatus({ state: "listening", port: this.port, error: undefined });
  }

  private stop() {
    this.tunnel.stop();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.disconnectClients();
    if (this.server) {
      this.server.close();
      this.server.closeAllConnections();
      this.server = null;
      this.port = 0;
    }
    if (this.status.state !== "off") this.setStatus({ state: "off", port: undefined, clients: 0, error: undefined });
  }

  private disconnectClients() {
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.updateClients();
  }

  private setStatus(patch: Partial<RemoteControlStatus>) {
    this.status = { ...this.status, ...patch };
    this.deps.onStatus(this.status);
  }

  private updateClients() {
    if (this.status.clients !== this.clients.size) this.setStatus({ clients: this.clients.size });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!pathname.startsWith("/api/")) return this.serveStatic(req, res, pathname);
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "POST" && pathname === "/api/login") return this.login(req, res);
    if (req.method === "POST" && pathname === "/api/logout") {
      const sid = sessionCookie(req);
      if (sid) this.deps.sessions.revoke(sid);
      res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=${cookiePath(req)}; Max-Age=0`);
      return sendJson(res, 200, { ok: true });
    }
    if (!this.authorized(req)) throw new HttpError(401, "需要登录");
    if (req.method === "GET" && pathname === "/api/events") return this.openEvents(req, res);
    if (req.method === "POST" && pathname === "/api/invoke") return this.invoke(req, res);
    throw new HttpError(404, "Not found");
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
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ seq: this.seq })}\n\n`);
    this.clients.add(res);
    this.updateClients();
    req.on("close", () => {
      this.clients.delete(res);
      this.updateClients();
    });
  }

  private async invoke(req: IncomingMessage, res: ServerResponse) {
    requireRemoteHeader(req);
    const body = await readJson(req, MAX_INVOKE_BYTES) as { channel?: unknown; args?: unknown };
    const channel = typeof body.channel === "string" ? body.channel : "";
    const args = Array.isArray(body.args) ? body.args : [];
    try {
      sendJson(res, 200, { ok: true, result: await this.dispatch(channel, args) });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async dispatch(channel: string, args: unknown[]): Promise<unknown> {
    if (channel === "chat:live") {
      return [...this.states.values()].filter((event) => this.deps.hasSession(event.sessionKey));
    }
    if (channel === "chat:snapshot") return this.snapshot(String(args[0] ?? ""));
    if (!checkRemoteInvoke(this.deps.policy, channel, args)) throw new HttpError(403, `远程不能调用：${channel}`);
    const result = await this.deps.invoke(channel, args);
    return channel === "settings:get" ? remoteSettings(result as Settings) : result;
  }

  private snapshot(sessionKey: string): RemoteSessionSnapshot | null {
    // liveRows 会同步发出缓冲中的增量，因此取完行再读 seq。
    const rows = this.deps.liveRows(sessionKey);
    if (!rows) return null;
    return {
      seq: this.seq,
      rows,
      state: this.states.get(sessionKey) ?? null,
      permissions: [...this.permissions.values()].filter((event) => event.sessionKey === sessionKey),
    };
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
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": data.length,
      "Cache-Control": type.startsWith("text/html") ? "no-store" : "public, max-age=3600",
    });
    res.end(req.method === "HEAD" ? undefined : data);
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

function sendJson(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
