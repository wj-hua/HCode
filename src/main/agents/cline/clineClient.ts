// Cline ACP 使用 stdio NDJSON JSON-RPC；不需要引入 ACP SDK。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { JsonRpcMessage, ServerRequest } from "../codex/appServerClient.js";
import { isRecord } from "../rowProjectorBase.js";

export interface ClineLaunch { path: string; env: Record<string, string>; cwd: string; effort?: string; modelId?: string; authMethod?: string }
type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export class ClineClient extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private failure: string | undefined;
  private exited = false;
  private readonly authMethod: string | undefined;
  readonly closed: Promise<void>;

  constructor(launch: ClineLaunch) {
    super();
    this.authMethod = launch.authMethod;
    const args = ["--acp", "--auto-approve", "false", "--cwd", launch.cwd];
    if (launch.effort) args.push("--thinking", launch.effort);
    // ACP 的事件、审批和取消属于此进程；共享 Hub 可能保留过期的提供商目录。
    this.child = spawn(launch.path, args, { cwd: launch.cwd, env: { ...launch.env, CLINE_SESSION_BACKEND_MODE: "local" }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.on("error", (error) => { this.failure = error.message; });
    this.child.stdin.on("error", (error) => { this.failure = error.message; this.dispose(); });
    this.closed = new Promise((resolve) => this.child.once("close", (code, signal) => {
      this.exited = true;
      const reason = this.failure ?? `Cline 进程已退出（${signal ?? code}）${this.stderr.trim() ? `：${this.stderr.trim().split("\n").at(-1)}` : ""}`;
      for (const pending of this.pending.values()) pending.reject(new Error(reason));
      this.pending.clear();
      this.emit("exit", reason);
      resolve();
    }));
  }

  private read(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error("ACP 事件过大");
        const value: unknown = JSON.parse(line);
        if (!isRecord(value)) throw new Error("ACP 事件不是对象");
        const message = value as JsonRpcMessage;
        if (message.method && message.id !== undefined) {
          this.emit("request", { id: message.id, method: message.method, params: isRecord(message.params) ? message.params : {} } satisfies ServerRequest);
        } else if (message.method) {
          this.emit("notification", message.method, isRecord(message.params) ? message.params : {});
        } else if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) {
            const reason = message.error.message ?? "Cline 请求失败";
            pending?.reject(new Error(/Authentication required|auth_required/i.test(reason) ? "Cline 尚未登录，请先在终端执行 cline auth" : reason));
          } else pending?.resolve(message.result);
        }
      } catch (error) {
        this.failure = `Cline ACP 无效：${error instanceof Error ? error.message : String(error)}`;
        this.dispose();
        return;
      }
    }
    if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) {
      this.failure = "Cline ACP 未结束事件过大";
      this.dispose();
    }
  }

  private write(message: JsonRpcMessage) {
    if (this.exited || this.child.stdin.destroyed) throw new Error("Cline 进程未运行");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      // prompt 在审批时可无限等待；握手与配置请求设超时。
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.failure = `Cline 请求超时：${method}`;
        this.dispose(); // close 后才释放执行锁。
      }, timeoutMs) : undefined;
      const clear = () => { if (timer) clearTimeout(timer); };
      this.pending.set(id, {
        resolve: (value) => { clear(); resolve(value as T); },
        reject: (error) => { clear(); reject(error); },
      });
      try { this.write({ id, method, params }); }
      catch (error) { this.pending.delete(id); clear(); reject(error); }
    });
  }

  notify(method: string, params: unknown) { this.write({ method, params }); }
  respond(id: number | string, result: unknown) { this.write({ id, result }); }
  unsupported(id: number | string) { this.write({ id, error: { code: -32601, message: "HCode 不支持该客户端方法" } }); }

  async initialize() {
    const result = await this.request<Record<string, unknown>>("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "hcode", title: "HCode", version: "1" },
      clientCapabilities: {},
    });
    if (result.protocolVersion !== 1) throw new Error("Cline ACP 协议版本不兼容，请更新 CLI");
    // 仅复用配置中已经存在的 OAuth 凭据，不发起新的登录流程。
    if (this.authMethod) await this.request("authenticate", { methodId: this.authMethod });
    return result;
  }

  dispose() {
    if (this.exited) return;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => { if (!this.exited) this.child.kill("SIGKILL"); }, 3000);
    timer.unref();
    void this.closed.then(() => clearTimeout(timer));
  }
}
