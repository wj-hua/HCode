// 一个正在进行的 Antigravity 会话：对应一个 `agy -p --input-format stream-json --output-format stream-json` 子进程，
// stdin 每写一行 {"event":"user"} 跑一轮，进程在轮次之间保持，下一条消息接着同一个 conversation。
// 无头模式没有审批：需要确认的操作由 agy 自动拒绝（结果里的 denied_actions）；
// 停止 = 发 SIGINT（进程随之退出），权限模式 / 模型变化后，下一次发送用 --conversation 重启进程续上。
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgyProcess } from "./agyProcess.js";
import { agyResult } from "./agyResult.js";
import { AgyResearchSession } from "./agyResearchSession.js";
import type { ResearchRuntime } from "../../sessions/researchRuntime.js";
import { TurnLifecycle } from "../../sessions/turnLifecycle.js";
import type { TurnOutcome } from "../../../shared/collaboration.js";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ChatRunState,
  ChatStateEvent,
  ChatUsage,
  FileInput,
  ImageInput,
  PermissionMode,
  RowOp,
} from "../../../shared/types.js";
import { isRecord, type JsonRecord } from "../rowProjectorBase.js";
import { withFileReferences } from "../fileAttachments.js";
import { withProjectFilePaths } from "../../projectFiles.js";
import { AgyRowProjector, uploadedImagesNote, type AgyStep } from "./agyProjector.js";

/** agy CLI 的数据目录（会话、transcript、上传的图片都在这里）。 */
export const AGY_DATA_DIR = join(homedir(), ".gemini/antigravity-cli");

const FLUSH_INTERVAL_MS = 16;
const INIT_TIMEOUT_MS = 60_000;
const cumulativeUsageSchema = z.object({ input_tokens: z.number().finite().nonnegative(), cache_read_tokens: z.number().finite().nonnegative(), output_tokens: z.number().finite().nonnegative() });

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

export interface AgySessionHost {
  resolveLaunch(cwd: string, args: string[]): Promise<AgyLaunch>;
  emitRows(sessionKey: string, ops: RowOp[]): void;
  emitState(event: ChatStateEvent): void;
  /** 一轮跑完：transcript 此时已写入，用于刷新会话列表。 */
  onSettled(session: AgySession): void;
  emitTurnOutcome?(event: TurnOutcome): void;
}

export class AgySession {
  readonly key: string;
  readonly projectPath: string;
  sessionId: string | undefined;
  permissionMode: PermissionMode;
  model: string | undefined;
  /** agy 实际使用的模型（init 事件返回）。 */
  private reportedModel: string | undefined;

  private usage: ChatUsage | undefined;
  /** 上一次 result 里的累计用量（整个 conversation 累计，跨进程重启也连续），用来相减得到本轮用量。 */
  private lastTotals: { input: number; output: number } | undefined;
  private readonly projector = new AgyRowProjector();
  private process: AgyProcess | null = null;
  private starting: Promise<AgyProcess> | null = null;
  /** 当前进程启动时的参数，与现在的设置不同就要重启。 */
  private launchedWith = "";
  private state: ChatRunState = "idle";
  private error: string | undefined;
  private protocolError: string | undefined;
  private interruptRequested = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly lifecycle: TurnLifecycle;
  private lastResultTurn = 0;
  private research?: ResearchRuntime;
  private readonly bounded?: AgyResearchSession;

  constructor(
    private readonly host: AgySessionHost,
    options: { key: string; projectPath: string; sessionId?: string; permissionMode: PermissionMode; model?: string; research?: ResearchRuntime; researchRoot?: string },
  ) {
    this.key = options.key;
    this.lifecycle = new TurnLifecycle(this.key, "agy", (event) => this.host.emitTurnOutcome?.(event));
    this.projectPath = options.projectPath;
    this.sessionId = options.sessionId;
    this.permissionMode = options.permissionMode;
    this.model = options.model || undefined;
    this.research = options.research;
    if (options.research) {
      if (!options.researchRoot) throw new Error("agy 缺少 HCode 自有角色目录");
      this.bounded = new AgyResearchSession(options.researchRoot, this.key);
    }
  }

  /** 执行者复用同一研究角色；不把普通历史会话升级为另一个原生身份。 */
  configureResearch(runtime: ResearchRuntime | undefined) {
    if (this.isBusy) throw new Error("agy 会话仍在运行");
    if (Boolean(runtime) !== Boolean(this.bounded) || runtime && runtime.root !== this.projectPath) throw new Error("agy 研究角色或项目归属不匹配");
    this.research = runtime;
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

  async send(text: string, images: readonly ImageInput[] = [], files: readonly FileInput[] = [], executionTurnId: string = randomUUID()) {
    if (this.closed) throw new Error("会话已关闭");
    this.lifecycle.begin(executionTurnId);
    this.error = undefined;
    this.protocolError = undefined;
    this.usage = undefined;
    this.projector.beginLocalTurn(text, Date.now(), images, files);
    this.flushNow();
    this.setState("running");
    try {
      if (this.research) await this.bounded!.prepare(this.research);
      const agy = await this.ensureProcess();
      const paths = await this.saveImages(images);
      if (!this.isBusy || this.interruptRequested) return; // 中断仍等待原生退出确认
      const prompt = this.research ? text : withFileReferences(await withProjectFilePaths(text, this.projectPath), files);
      agy.sendUser(paths.length > 0 ? `${prompt}${uploadedImagesNote(paths)}` : prompt);
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
    const args = this.bounded ? this.bounded.args(this.research?.outputSchema) : ["--add-dir", this.projectPath];
    if (this.sessionId) args.push("--conversation", this.sessionId);
    if (this.model) args.push("--model", this.model);
    if (!this.bounded && this.permissionMode === "accept-edits") args.push("--mode", "accept-edits");
    else if (!this.bounded && this.permissionMode === "bypass") args.push("--dangerously-skip-permissions");
    return args;
  }

  private async ensureProcess(): Promise<AgyProcess> {
    const signature = JSON.stringify([this.permissionMode, this.model ?? "", this.research?.outputSchema]);
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
    const agy = new AgyProcess(await this.host.resolveLaunch(this.bounded?.workspace ?? this.projectPath, this.launchArgs()));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("agy 启动超时")), INIT_TIMEOUT_MS);
      agy.on("event", (event: JsonRecord) => {
        if (event.event === "init") {
          clearTimeout(timer);
          if (typeof event.conversation_id !== "string" || this.sessionId && this.sessionId !== event.conversation_id) { reject(new Error("agy 初始化会话身份缺失或变化")); agy.dispose(); return; }
          this.sessionId = event.conversation_id;
          const init = isRecord(event.init) ? event.init : {};
          try { this.bounded?.validateInit(init, this.model); }
          catch (error) { reject(error); agy.dispose(); return; }
          if (typeof init.model === "string") this.reportedModel = init.model;
          this.process = agy;
          this.launchedWith = signature;
          if (this.closed) agy.dispose();
          else if (this.interruptRequested) agy.interrupt();
          resolve();
        } else if (this.process === agy) {
          this.handleEvent(event);
        }
      });
      agy.on("protocolError", (reason: string) => { this.protocolError = reason; this.bounded?.stop(); });
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
    if (this.interruptRequested) this.settle(Date.now(), { outcome: "interrupted", text: "" });
    else this.fail(this.protocolError ?? reason);
  }

  // ───────────────────────── 事件处理 ─────────────────────────

  private handleEvent(event: JsonRecord) {
    const now = Date.now();
    if (event.event === "step_update" && isRecord(event.step_update)) {
      this.projector.streamStep(event.step_update, now);
      this.scheduleFlush();
    } else if (event.event === "result") {
      if (!this.isBusy || this.interruptRequested) return;
      try {
        const native = agyResult(event.result, this.sessionId);
        if (native.result.num_turns <= this.lastResultTurn) return;
        this.lastResultTurn = native.result.num_turns;
        this.error = native.error;
        if (this.error) this.projector.notice(`Antigravity 出错：${this.error}`, now, true);
        this.recordUsage(native.result);
        if (!this.interruptRequested) this.settle(now, native);
      } catch (error) { this.protocolError = `agy stream-json 结果无效：${error instanceof Error ? error.message : String(error)}`; this.bounded?.stop(); this.process?.dispose(); }
    }
  }

  /**
   * result.usage 是整个 conversation 的累计值（不是本轮）：本轮 = 与上一次 result 的差。
   * 没有上一次记录时（打开历史会话后的第一轮），只有 num_turns 为 1 才能确定累计值就是本轮。
   * agy 不报告上下文窗口，所以只显示 Token；输出 Token 已包含思考 Token，输入包含缓存命中。
   */
  private recordUsage(result: JsonRecord) {
    const usage = cumulativeUsageSchema.safeParse(result.usage);
    // 缺失或无效累计用量无法算出本轮差值；下一轮先重建基线，保留未知状态。
    if (!usage.success) { this.lastTotals = undefined; return; }
    const totals = { input: usage.data.input_tokens + usage.data.cache_read_tokens, output: usage.data.output_tokens };
    const previous = this.lastTotals;
    this.lastTotals = totals;
    if (!previous && result.num_turns !== 1) return;
    if (previous && (totals.input < previous.input || totals.output < previous.output)) return;
    const turn = previous ? { input: totals.input - previous.input, output: totals.output - previous.output } : totals;
    this.usage = { inputTokens: turn.input, outputTokens: turn.output };
  }

  private settle(at: number, result: Pick<TurnOutcome, "outcome" | "text">) {
    this.bounded?.stop();
    this.lifecycle.finish({ ...result, ...(this.error ? { error: this.error } : {}), nativeSessionId: this.sessionId, ...(this.usage ? { usage: this.usage } : {}) });
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
    this.bounded?.stop();
    this.lifecycle.requestCancellation();
    this.interruptRequested = true;
    if (this.process) this.process.interrupt();
    // 启动中的进程在 init 后收到中断；不提前发出停止确认。
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
    if (this.isBusy) { this.lifecycle.requestCancellation(); this.interruptRequested = true; }
    this.bounded?.close();
    this.process?.dispose();
  }

  private fail(message: string) {
    this.bounded?.stop();
    this.lifecycle.finish({ outcome: "failed", text: "", error: message, nativeSessionId: this.sessionId });
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
      ...(this.usage ? { usage: this.usage } : {}),
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
