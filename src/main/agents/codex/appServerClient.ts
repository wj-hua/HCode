// codex app-server 客户端：按行分隔的 JSON-RPC（stdio），一个 HCode 进程共用一个 app-server。
// 协议类型可用 `codex app-server generate-ts` 生成；这里只按需声明用到的字段。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface ServerRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const REQUEST_TIMEOUT_MS = 120_000;

export class AppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderrTail = "";

  constructor(
    private readonly resolveLaunch: () => Promise<{ path: string; env: Record<string, string> }>,
    /** initialize 握手里上报的 HCode 版本。 */
    private readonly clientVersion: string,
  ) {
    super();
    this.setMaxListeners(100);
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** 确保 app-server 已启动并完成 initialize 握手。 */
  ensureStarted(): Promise<void> {
    if (this.child) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start() {
    const { path, env } = await this.resolveLaunch();
    const child = spawn(path, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
      if (process.env.HCODE_DEBUG) process.stderr.write(`[codex] ${chunk}`);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      const reason = `codex app-server 已退出（${signal ?? code}）${this.stderrTail ? `：${this.stderrTail.trim().split("\n").at(-1)}` : ""}`;
      for (const pending of this.pending.values()) pending.reject(new Error(reason));
      this.pending.clear();
      this.emit("exit", reason);
    });
    child.on("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.emit("exit", error.message);
    });
    await this.request("initialize", {
      clientInfo: { name: "hcode", title: "HCode", version: this.clientVersion },
      capabilities: null,
    });
    this.notify("initialized");
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    // 只按 \n 切分（不能用 readline：它会把 U+2028/U+2029 也当作换行）
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: JsonRpcMessage) {
    if (message.method && message.id !== undefined) {
      this.emit("request", {
        id: message.id,
        method: message.method,
        params: (message.params ?? {}) as Record<string, unknown>,
      } satisfies ServerRequest);
      return;
    }
    if (message.method) {
      this.emit("notification", message.method, (message.params ?? {}) as Record<string, unknown>);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "codex 请求失败"));
      else pending.resolve(message.result);
    }
  }

  private write(message: JsonRpcMessage) {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.child) return Promise.reject(new Error("codex app-server 未启动"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`codex 请求超时：${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** 启动后再发请求的便捷方法。 */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.ensureStarted();
    return this.request<T>(method, params);
  }

  notify(method: string, params?: unknown) {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: number | string, result: unknown) {
    this.write({ id, result });
  }

  respondError(id: number | string, message: string) {
    this.write({ id, error: { code: -32000, message } });
  }

  dispose() {
    const child = this.child;
    this.child = null;
    child?.stdin.end();
    child?.kill();
  }
}
