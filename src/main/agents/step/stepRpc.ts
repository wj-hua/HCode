// `step --mode rpc` / `pi --mode rpc` 客户端：stdin 写命令、stdout 读响应与事件（严格 JSONL，只按 \n 切分）。
// 与 codex app-server 不同，一个 step 进程只驱动一个会话，所以每个 HCode 会话各起一个进程。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { isRecord, type JsonRecord } from "../rowProjectorBase.js";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const REQUEST_TIMEOUT_MS = 60_000;

export interface StepLaunch {
  /** 错误信息里的命令名（step / pi） */
  command: string;
  path: string;
  env: Record<string, string>;
  cwd: string;
  args: string[];
}

/** 事件：`event`（除 response 外的所有输出行）、`exit`（进程意外退出，参数为原因）。 */
export class StepRpcProcess extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private stderrTail = "";
  private exited = false;
  private readonly command: string;

  constructor(launch: StepLaunch) {
    super();
    this.command = launch.command;
    const child = spawn(launch.path, ["--mode", "rpc", ...launch.args], {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
      if (process.env.HCODE_DEBUG) process.stderr.write(`[${this.command}] ${chunk}`);
    });
    child.on("exit", (code, signal) => {
      const lastLine = this.stderrTail.trim().split("\n").at(-1);
      this.finish(`${this.command} 进程已退出（${signal ?? code}）${lastLine ? `：${lastLine}` : ""}`);
    });
    child.on("error", (error) => this.finish(error.message));
  }

  get running(): boolean {
    return !this.exited;
  }

  private finish(reason: string) {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
    this.emit("exit", reason);
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    // 不能用 readline：它会把 U+2028/U+2029 也当作换行
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (isRecord(message)) this.dispatch(message);
    }
  }

  private dispatch(message: JsonRecord) {
    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.success === false) pending.reject(new Error(String(message.error ?? `${String(message.command)} 失败`)));
      else pending.resolve(message.data);
      return;
    }
    this.emit("event", message);
  }

  private write(message: JsonRecord) {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** 发送命令并等待对应的 response（按 id 关联）。 */
  request<T = unknown>(type: string, params: JsonRecord = {}): Promise<T> {
    if (this.exited) return Promise.reject(new Error(`${this.command} 进程未运行`));
    const id = `hcode-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${this.command} 请求超时：${type}`));
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
      this.write({ ...params, id, type });
    });
  }

  /** 回复 extension_ui_request（审批 confirm / select / input 等对话框）。 */
  respondUi(id: string, response: { confirmed: boolean } | { value: string } | { cancelled: true }) {
    this.write({ type: "extension_ui_response", id, ...response });
  }

  dispose() {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) pending.reject(new Error(`${this.command} 进程已关闭`));
    this.pending.clear();
    this.child.stdin.end();
    this.child.kill();
  }
}
