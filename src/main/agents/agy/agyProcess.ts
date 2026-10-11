// agy stream-json 子进程传输；只在进程 close 后确认退出，保持取消可观测。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { isRecord } from "../rowProjectorBase.js";
import type { AgyLaunch } from "./agySession.js";
const MAX_STREAM_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_TAIL_CHARACTERS = 4000;

/** 事件：`event`（stdout 的每个 JSON 行）、`exit`（进程退出，参数为原因）。 */
export class AgyProcess extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private stderrTail = "";
  private exited = false;

  constructor(launch: AgyLaunch) {
    super();
    const args = [...launch.args, "--input-format", "stream-json", "--output-format", "stream-json", "-p="];
    const child = spawn(launch.path, args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_TAIL_CHARACTERS);
      if (process.env.HCODE_DEBUG) process.stderr.write(`[agy] ${chunk}`);
    });
    child.on("close", (code, signal) => {
      const lastLine = this.stderrTail.trim().split("\n").at(-1);
      this.finish(`agy 进程已退出（${signal ?? code}）${lastLine ? `：${lastLine}` : ""}`);
    });
    child.on("error", (error) => this.finish(error.message));
  }

  get running(): boolean {
    return !this.exited;
  }

  private finish(reason: string) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", reason);
  }

  private protocolFailure(message: string) {
    this.emit("protocolError", `agy stream-json 无效：${message}`);
    this.child.kill(); // 实际 close 后由 Session 确认失败，不能提前释放执行锁。
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_STREAM_LINE_BYTES) { this.protocolFailure("事件超过大小限制"); return; }
      let message: unknown;
      try { message = JSON.parse(line); }
      catch (error) { this.protocolFailure(error instanceof Error ? error.message : String(error)); return; }
      if (!isRecord(message)) { this.protocolFailure("事件必须是对象"); return; }
      this.emit("event", message);
    }
    if (Buffer.byteLength(this.buffer) > MAX_STREAM_LINE_BYTES) this.protocolFailure("未结束事件超过大小限制");
  }

  sendUser(text: string) {
    if (this.exited) throw new Error("agy 进程未运行");
    const message = { event: "user", message: { role: "user", content: [{ type: "text", text }] } };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** 等同终端里按 Ctrl+C：agy 结束当前轮（result 为 interrupted）后退出。 */
  interrupt() {
    if (!this.exited) this.child.kill("SIGINT");
  }

  dispose() {
    if (this.exited) return;
    this.child.stdin.end();
    this.child.kill();
  }
}
