// 一个正在进行的 Antigravity 会话：对应一个 `agy -p --input-format stream-json --output-format stream-json` 子进程，
// stdin 每写一行 {"event":"user"} 跑一轮，进程在轮次之间保持，下一条消息接着同一个 conversation。
// 无头模式没有审批：需要确认的操作由 agy 自动拒绝（结果里的 denied_actions）；
// 停止 = 发 SIGINT（进程随之退出），权限模式 / 模型变化后，下一次发送用 --conversation 重启进程续上。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ChatRunState,
  ChatStateEvent,
  ImageInput,
  PermissionMode,
  RowOp,
} from "../../../shared/types.js";
import { isRecord, type JsonRecord } from "../rowProjectorBase.js";
import { AgyRowProjector, uploadedImagesNote, type AgyStep } from "./agyProjector.js";

/** agy CLI 的数据目录（会话、transcript、上传的图片都在这里）。 */
export const AGY_DATA_DIR = join(homedir(), ".gemini/antigravity-cli");

const FLUSH_INTERVAL_MS = 16;
const INIT_TIMEOUT_MS = 60_000;

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export interface AgyLaunch {
  path: string;
  env: Record<string, string>;
  cwd: string;
  args: string[];
}

/** 事件：`event`（stdout 的每个 JSON 行）、`exit`（进程退出，参数为原因）。 */
class AgyProcess extends EventEmitter {
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
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
      if (process.env.HCODE_DEBUG) process.stderr.write(`[agy] ${chunk}`);
    });
    child.on("exit", (code, signal) => {
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

  private onData(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.startsWith("{")) continue;
      try {
        const message: unknown = JSON.parse(line);
        if (isRecord(message)) this.emit("event", message);
      } catch {
        // 非 JSON 行忽略
      }
    }
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
    this.exited = true;
    this.child.stdin.end();
    this.child.kill();
  }
}

export interface AgySessionHost {
  resolveLaunch(cwd: string, args: string[]): Promise<AgyLaunch>;
  emitRows(sessionKey: string, ops: RowOp[]): void;
  emitState(event: ChatStateEvent): void;
  /** 一轮跑完：transcript 此时已写入，用于刷新会话列表。 */
  onSettled(session: AgySession): void;
}

export class AgySession {
  readonly key: string;
  readonly projectPath: string;
  sessionId: string | undefined;
  permissionMode: PermissionMode;
  model: string | undefined;
  /** agy 实际使用的模型（init 事件返回）。 */
  private reportedModel: string | undefined;

  private readonly projector = new AgyRowProjector();
  private process: AgyProcess | null = null;
  private starting: Promise<AgyProcess> | null = null;
  /** 当前进程启动时的参数，与现在的设置不同就要重启。 */
  private launchedWith = "";
  private state: ChatRunState = "idle";
  private error: string | undefined;
  private interruptRequested = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly host: AgySessionHost,
    options: { key: string; projectPath: string; sessionId?: string; permissionMode: PermissionMode; model?: string },
  ) {
    this.key = options.key;
    this.projectPath = options.projectPath;
    this.sessionId = options.sessionId;
    this.permissionMode = options.permissionMode;
    this.model = options.model || undefined;
  }

  get isBusy(): boolean {
    return this.state === "running";
  }

  seedHistory(steps: readonly AgyStep[]) {
    let lastAt = 0;
    for (const step of steps) {
      this.projector.consumeStep(step);
      lastAt = Math.max(lastAt, Date.parse(String(step.created_at ?? "")) || 0);
    }
    this.projector.closeTurn(lastAt || Date.now());
    this.projector.drain();
    this.host.emitRows(this.key, [{ op: "reset", rows: this.projector.snapshot() }]);
  }

  async send(text: string, images: readonly ImageInput[] = []) {
    if (this.closed) throw new Error("会话已关闭");
    this.error = undefined;
    this.projector.beginLocalTurn(text, Date.now(), images);
    this.flushNow();
    this.setState("running");
    try {
      const agy = await this.ensureProcess();
      const paths = await this.saveImages(images);
      if (!this.isBusy) return; // 启动期间已被停止
      agy.sendUser(paths.length > 0 ? `${text}${uploadedImagesNote(paths)}` : text);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** 图片存到 agy 自己放上传图片的位置（brain/<会话>/.user_uploaded），模型用 view_file 读取。 */
  private async saveImages(images: readonly ImageInput[]): Promise<string[]> {
    if (images.length === 0 || !this.sessionId) return [];
    const dir = join(AGY_DATA_DIR, "brain", this.sessionId, ".user_uploaded");
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    return Promise.all(
      images.map(async (image, index) => {
        const path = join(dir, `uploaded_media_${now}_${index}.${IMAGE_EXT[image.mimeType] ?? "png"}`);
        await writeFile(path, Buffer.from(image.data, "base64"));
        return path;
      }),
    );
  }

  private launchArgs(): string[] {
    // --add-dir 把项目目录设为工作区（只对本次运行生效）：否则不在 agy 信任列表里的目录没有工作区，命令会跑在 agy 的 scratch 目录
    const args = ["--add-dir", this.projectPath];
    if (this.sessionId) args.push("--conversation", this.sessionId);
    if (this.model) args.push("--model", this.model);
    if (this.permissionMode === "accept-edits") args.push("--mode", "accept-edits");
    else if (this.permissionMode === "bypass") args.push("--dangerously-skip-permissions");
    return args;
  }

  private async ensureProcess(): Promise<AgyProcess> {
    const signature = JSON.stringify([this.permissionMode, this.model ?? ""]);
    if (this.process?.running && this.launchedWith === signature) return this.process;
    if (this.starting) return this.starting;
    this.process?.dispose();
    this.process = null;
    this.starting = this.startProcess(signature).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** 启动进程并等到 init 事件（带 conversation_id，新会话由此得到 id）。 */
  private async startProcess(signature: string): Promise<AgyProcess> {
    const agy = new AgyProcess(await this.host.resolveLaunch(this.projectPath, this.launchArgs()));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("agy 启动超时")), INIT_TIMEOUT_MS);
      agy.on("event", (event: JsonRecord) => {
        if (event.event === "init") {
          clearTimeout(timer);
          if (typeof event.conversation_id === "string") this.sessionId = event.conversation_id;
          const init = isRecord(event.init) ? event.init : {};
          if (typeof init.model === "string") this.reportedModel = init.model;
          this.process = agy;
          this.launchedWith = signature;
          resolve();
        } else if (this.process === agy) {
          this.handleEvent(event);
        }
      });
      agy.on("exit", (reason: string) => {
        clearTimeout(timer);
        reject(new Error(reason));
        this.onExit(agy, reason);
      });
    }).catch((error: unknown) => {
      agy.dispose();
      throw error;
    });
    this.emitState();
    return agy;
  }

  private onExit(agy: AgyProcess, reason: string) {
    if (this.process !== agy) return;
    this.process = null;
    if (!this.isBusy) return;
    // 停止时进程在 result 之前退出也算正常结束
    if (this.projector.hasOpenTurn && this.interruptRequested) this.settle(Date.now());
    else this.fail(reason);
  }

  // ───────────────────────── 事件处理 ─────────────────────────

  private handleEvent(event: JsonRecord) {
    const now = Date.now();
    if (event.event === "step_update" && isRecord(event.step_update)) {
      this.projector.streamStep(event.step_update, now);
      this.scheduleFlush();
    } else if (event.event === "result" && isRecord(event.result)) {
      const result = event.result;
      if (result.status === "ERROR" && result.error !== "interrupted") {
        this.error = typeof result.error === "string" && result.error ? result.error : "Antigravity 执行出错";
      }
      const denied = Array.isArray(result.denied_actions) ? result.denied_actions : [];
      if (denied.length > 0) {
        const lines = denied.map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`);
        this.projector.notice(`以下操作需要确认，无头模式下已被自动拒绝：\n${lines.join("\n")}`, now);
      }
      if (this.error) this.projector.notice(`Antigravity 出错：${this.error}`, now, true);
      this.settle(now);
    }
  }

  private settle(at: number) {
    if (this.interruptRequested) this.projector.markInterrupted();
    this.interruptRequested = false;
    this.projector.closeTurn(at, this.error ? "failed" : undefined);
    this.flushNow();
    this.setState(this.error ? "error" : "idle");
    this.host.onSettled(this);
  }

  // ───────────────────────── 控制 ─────────────────────────

  async interrupt() {
    if (!this.isBusy) return;
    this.interruptRequested = true;
    if (this.process) this.process.interrupt();
    else this.settle(Date.now());
  }

  async setPermissionMode(mode: PermissionMode) {
    this.permissionMode = mode; // 下一次发送时重启进程生效
    this.emitState();
  }

  async setModel(model: string) {
    this.model = model || undefined;
    this.emitState();
  }

  close() {
    this.closed = true;
    this.process?.dispose();
    this.process = null;
  }

  private fail(message: string) {
    this.error = message;
    this.interruptRequested = false;
    this.projector.failTurn(`Antigravity 出错：${message}`, Date.now());
    this.flushNow();
    this.setState("error");
  }

  private setState(state: ChatRunState) {
    if (this.state === state) return;
    this.state = state;
    this.emitState();
  }

  emitState() {
    const model = this.model ?? this.reportedModel;
    this.host.emitState({
      sessionKey: this.key,
      agent: "agy",
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      projectPath: this.projectPath,
      state: this.state,
      ...(this.error ? { error: this.error } : {}),
      permissionMode: this.permissionMode,
      ...(model ? { model } : {}),
    });
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushNow(), FLUSH_INTERVAL_MS);
  }

  private flushNow() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const ops = this.projector.drain();
    if (ops.length > 0) this.host.emitRows(this.key, ops);
  }
}
