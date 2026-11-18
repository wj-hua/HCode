// agy acp --stdio 的 JSON-RPC 2.0 传输层：支持实时 thought/message chunk、工具流与权限审批。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { isRecord, type JsonRecord } from "../rowProjectorBase.js";
import type { AgyLaunch } from "./agySession.js";

const MAX_ACP_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_TAIL_CHARACTERS = 4000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface AgyAcpServerRequest {
  id: number | string;
  method: string;
  params: JsonRecord;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** 事件：`notification`（method, params）、`request`（AgyAcpServerRequest）、`protocolError`（reason）、`exit`（reason）。 */
export class AgyAcpProcess extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private stderrTail = "";
  private exited = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(launch: AgyLaunch) {
    super();
    const args = ["acp", "--stdio", ...launch.args];
    const child = spawn(launch.path, args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_TAIL_CHARACTERS);
      if (process.env.HCODE_DEBUG) process.stderr.write(`[agy-acp] ${chunk}`);
    });
    child.on("close", (code, signal) => {
      const lastLine = this.stderrTail.trim().split("\n").at(-1);
      this.finish(`agy acp 进程已退出（${signal ?? code}）${lastLine ? `：${lastLine}` : ""}`);
    });
    child.on("error", (error) => this.finish(error.message));
  }

  get running(): boolean {
    return !this.exited;
  }

  private finish(reason: string) {
    if (this.exited) return;
    this.exited = true;
    for (const item of this.pending.values()) {
      if (item.timer) clearTimeout(item.timer);
      item.reject(new Error(reason));
    }
    this.pending.clear();
    this.emit("exit", reason);
  }

  private protocolFailure(message: string) {
    this.emit("protocolError", `agy acp 无效：${message}`);
    this.child.kill();
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_ACP_LINE_BYTES) {
        this.protocolFailure("消息超过大小限制");
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.protocolFailure(error instanceof Error ? error.message : String(error));
        return;
      }
      if (!isRecord(message)) {
        this.protocolFailure("消息必须是对象");
        return;
      }
      this.dispatch(message as JsonRpcMessage);
    }
    if (Buffer.byteLength(this.buffer) > MAX_ACP_LINE_BYTES) this.protocolFailure("未结束消息超过大小限制");
  }

  private dispatch(message: JsonRpcMessage) {
    if (message.method && message.id !== undefined) {
      this.emit("request", {
        id: message.id,
        method: message.method,
        params: isRecord(message.params) ? message.params : {},
      } satisfies AgyAcpServerRequest);
      return;
    }
    if (message.method) {
      this.emit("notification", message.method, isRecord(message.params) ? message.params : {});
      return;
    }
    if (typeof message.id === "number") {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message ?? "agy acp 请求失败"));
      else entry.resolve(message.result);
    }
  }

  private write(payload: Record<string, unknown>) {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.exited) return Promise.reject(new Error("agy acp 进程未运行"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (this.pending.delete(id)) reject(new Error(`agy acp 请求超时：${method}`));
          }, timeoutMs)
        : undefined;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, ...(timer ? { timer } : {}) });
      this.write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: unknown) {
    if (!this.exited) this.write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  respond(id: number | string, result: unknown) {
    if (!this.exited) this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number | string, code: number, message: string) {
    if (!this.exited) this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  dispose() {
    if (this.exited) return;
    this.child.stdin.end();
    this.child.kill();
  }
}
