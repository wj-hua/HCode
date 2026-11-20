// 一个正在进行的 Antigravity 会话：
// - 普通交互会话使用 `agy acp --stdio`（JSON-RPC 2.0），实时接收 thought/message chunk、工具进度、上下文用量与权限审批；
// - 受限研究/结构化输出会话仍使用 `agy -p --input-format stream-json --output-format stream-json`（支持 --agent / --json-schema）。
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgyAcpProcess, type AgyAcpServerRequest } from "./agyAcpProcess.js";
import { AgyBackgroundTasks } from "./agyBackgroundTasks.js";
import { AgyProcess } from "./agyProcess.js";
import { agyResult } from "./agyResult.js";
import { AgyResearchSession } from "./agyResearchSession.js";
import type { ResearchRuntime } from "../../sessions/researchRuntime.js";
import { TurnLifecycle } from "../../sessions/turnLifecycle.js";
import type { TurnOutcome } from "../../../shared/collaboration.js";
import { mkdir, writeFile } from "node:fs/promises";
import { AGY_DATA_DIR, agyHistoryContext, agyStepContextTokens, AgyThinkingTranscript, transcriptPath } from "./agyThinkingTranscript.js";
import { agyContextUsage, agyContextWindowTokens } from "../../../shared/agyModels.js";
import { join } from "node:path";
import type {
  ChatRunState,
  ChatStateEvent,
  ChatUsage,
  FileInput,
  ImageInput,
  PermissionDecision,
  PermissionMode,
  PermissionRequestEvent,
  PermissionResolvedEvent,
  RowOp,
} from "../../../shared/types.js";
import { isRecord, type JsonRecord } from "../rowProjectorBase.js";
import { withFileReferences } from "../fileAttachments.js";
import { withProjectFilePaths } from "../../projectFiles.js";
import { AgyRowProjector, projectAgyTool, uploadedImagesNote, type AgyStep } from "./agyProjector.js";
import { AgyResponseMetrics } from "./agyResponseMetrics.js";
import { CodexResponseMetrics } from "../codex/codexResponseMetrics.js";
import { agyLiveSubagents, isAgyConversationId } from "./agySubagents.js";
import type { NativeSubagent } from "../../../shared/types.js";

export type AgyTransport = "acp" | "stream-json";

const FLUSH_INTERVAL_MS = 16;
const INIT_TIMEOUT_MS = 60_000;
const ACP_NATIVE_SETTLE_MS = 1200;
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
  emitPermission?(event: PermissionRequestEvent): void;
  emitPermissionResolved?(event: PermissionResolvedEvent): void;
  /** 一轮跑完：transcript 此时已写入，用于刷新会话列表。 */
  onSettled(session: AgySession): void;
  onSubagentsChanged?(session: AgySession): void;
  emitTurnOutcome?(event: TurnOutcome): void;
}

interface AcpPermissionOption {
  optionId: string;
  kind?: string;
  name?: string;
}

interface PendingAcpPermission {
  requestId: number | string;
  toolCallId: string;
  options: AcpPermissionOption[];
}

export class AgySession {
  readonly key: string;
  readonly projectPath: string;
  readonly transport: AgyTransport;
  sessionId: string | undefined;
  permissionMode: PermissionMode;
  model: string | undefined;
  effort: string | undefined;
  /** agy 实际使用的模型（init 事件或步骤记录返回）。 */
  private reportedModel: string | undefined;
  private readonly defaultModel: string | undefined;
  private readonly contextWindowOverrides: Readonly<Record<string, string>> | undefined;
  private contextUsedTokens: number | undefined;
  private acpContextWindowTokens: number | undefined;
  private lastContextStep = -1;
  private turnResponseSteps = 0;
  private turnStepContextUpdated = false;

  private usage: ChatUsage | undefined;
  private readonly responseMetrics = new AgyResponseMetrics();
  private readonly acpMetrics = new CodexResponseMetrics();
  readonly nativeSubagents = new Map<string, NativeSubagent>();
  /** 上一次 result 里的累计用量（整个 conversation 累计，跨进程重启也连续），用来相减得到本轮用量。 */
  private lastTotals: { input: number; output: number } | undefined;
  private readonly projector = new AgyRowProjector();
  private thinkingTranscript?: AgyThinkingTranscript;
  private process: AgyProcess | null = null;
  private starting: Promise<AgyProcess> | null = null;
  private acpProcess: AgyAcpProcess | null = null;
  private acpStarting: Promise<AgyAcpProcess> | null = null;
  private acpSupportsImage = false;
  private acpReplaying = false;
  private acpAvailableModels = new Set<string>();
  private acpAppliedModel: string | undefined;
  private acpAppliedEffort: string | undefined;
  private acpAppliedMode: string | undefined;
  private acpTurnToken = 0;
  private acpPromptInFlight = false;
  private acpNativeTurn = false;
  private acpNativeHasOutput = false;
  private acpNativeSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly acpNativeSettleMs: number;
  private readonly acpBackgroundTasks = new AgyBackgroundTasks();
  private readonly acpSeenTools = new Set<string>();
  private readonly acpTerminalTools = new Set<string>();
  private readonly acpPendingPermissions = new Map<string, PendingAcpPermission>();
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
    options: {
      key: string;
      projectPath: string;
      sessionId?: string;
      permissionMode: PermissionMode;
      model?: string;
      effort?: string;
      defaultModel?: string;
      contextWindowOverrides?: Readonly<Record<string, string>>;
      research?: ResearchRuntime;
      researchRoot?: string;
      transport?: AgyTransport;
      acpNativeSettleMs?: number;
    },
  ) {
    this.key = options.key;
    this.lifecycle = new TurnLifecycle(this.key, "agy", (event) => this.host.emitTurnOutcome?.(event));
    this.projectPath = options.projectPath;
    this.sessionId = options.sessionId;
    this.permissionMode = options.permissionMode;
    this.model = options.model || undefined;
    this.effort = options.effort || undefined;
    this.defaultModel = options.defaultModel || undefined;
    this.contextWindowOverrides = options.contextWindowOverrides;
    this.research = options.research;
    if (options.research) {
      if (!options.researchRoot) throw new Error("agy 缺少 HCode 自有角色目录");
      this.bounded = new AgyResearchSession(options.researchRoot, this.key);
    }
    this.transport = this.bounded ? "stream-json" : (options.transport ?? "stream-json");
    this.acpNativeSettleMs = options.acpNativeSettleMs ?? ACP_NATIVE_SETTLE_MS;
  }

  /** 执行者复用同一研究角色；不把普通历史会话升级为另一个原生身份。 */
  configureResearch(runtime: ResearchRuntime | undefined) {
    if (this.isBusy) throw new Error("agy 会话仍在运行");
    if (Boolean(runtime) !== Boolean(this.bounded) || runtime && runtime.root !== this.projectPath) throw new Error("agy 研究角色或项目归属不匹配");
    this.research = runtime;
  }

  get isBusy(): boolean {
    return this.state === "running" || this.state === "awaitingApproval";
  }

  get hasBackgroundTasks(): boolean {
    return this.acpBackgroundTasks.count > 0;
  }

  seedHistory(steps: readonly AgyStep[]) {
    let lastAt = 0;
    for (const step of steps) {
      this.projector.consumeStep(step);
      lastAt = Math.max(lastAt, Date.parse(String(step.created_at ?? "")) || 0);
    }
    this.projector.closeTurn(lastAt || Date.now());
    this.projector.drain();
    const history = agyHistoryContext(steps);
    if (history.lastStepIndex !== undefined) this.lastContextStep = Math.max(this.lastContextStep, history.lastStepIndex);
    if (history.model && !this.reportedModel) this.reportedModel = history.model;
    this.contextUsedTokens = history.usedTokens;
    this.refreshContextUsage();
    this.host.emitRows(this.key, [{ op: "reset", rows: this.projector.snapshot() }]);
  }

  async send(text: string, images: readonly ImageInput[] = [], files: readonly FileInput[] = [], executionTurnId: string = randomUUID()) {
    if (this.closed) throw new Error("会话已关闭");
    this.clearAcpNativeSettleTimer();
    this.acpNativeTurn = false;
    this.acpNativeHasOutput = false;
    this.lifecycle.begin(executionTurnId);
    this.error = undefined;
    this.protocolError = undefined;
    this.activeMetrics().start();
    this.turnResponseSteps = 0;
    this.turnStepContextUpdated = false;
    this.usage = this.contextUsage();
    const now = Date.now();
    if (this.transport === "acp") {
      this.projector.closeTurn(now, undefined, undefined, this.acpBackgroundTasks.runningToolIds());
    }
    this.projector.beginLocalTurn(text, now, images, files, executionTurnId);
    this.flushNow();
    this.setState("running");
    if (this.transport === "acp") {
      await this.sendAcp(text, images, files);
      return;
    }
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

  private activeMetrics() {
    return this.transport === "acp" ? this.acpMetrics : this.responseMetrics;
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
    if (this.effort) args.push("--effort", this.effort);
    if (!this.bounded && this.permissionMode === "accept-edits") args.push("--mode", "accept-edits");
    else if (!this.bounded && this.permissionMode === "bypass") args.push("--dangerously-skip-permissions");
    return args;
  }

  private async ensureProcess(): Promise<AgyProcess> {
    const signature = JSON.stringify([this.permissionMode, this.model ?? "", this.effort ?? "", this.research?.outputSchema]);
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
          if (typeof init.model === "string") {
            this.reportedModel = init.model;
            this.refreshContextUsage();
          }
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
    if (!this.isBusy) return;
    const now = Date.now();
    if (event.event === "step_update" && isRecord(event.step_update)) {
      const update = event.step_update;
      const isOwnConversation = update.conversation_id === undefined || update.conversation_id === this.sessionId;
      if (this.sessionId) for (const child of agyLiveSubagents(this.sessionId, update)) {
        const isNew = !this.nativeSubagents.has(child.id);
        this.nativeSubagents.set(child.id, child);
        if (isNew) this.host.onSubagentsChanged?.(this);
      }
      const metricsChanged = this.responseMetrics.consumeStep(update);
      let contextChanged = false;
      this.projector.streamStep(update, now);
      if (isOwnConversation && update.step_type === "checkpoint" && update.state === "DONE") {
        if (typeof update.step_index === "number") this.lastContextStep = Math.max(this.lastContextStep, update.step_index);
        this.contextUsedTokens = undefined;
        this.turnStepContextUpdated = true;
        this.refreshContextUsage();
        contextChanged = true;
      } else if (isOwnConversation && update.step_type === "agent_response" && update.state === "DONE") {
        this.turnResponseSteps++;
        const directModel = typeof update.model === "string" && update.model.trim() ? update.model.trim() : undefined;
        const directTokens = isRecord(update.usage) ? agyStepContextTokens(update.usage) : undefined;
        if (directTokens !== undefined || directModel) {
          const stepIndex = typeof update.step_index === "number" ? update.step_index : this.lastContextStep;
          contextChanged = this.updateStepContext(stepIndex, directTokens, directModel);
        }
        const needsTranscriptContext = directTokens === undefined || (!this.model && !this.reportedModel && !directModel);
        this.syncStepTranscript(update, needsTranscriptContext);
      }
      if (metricsChanged || contextChanged) this.emitState();
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
        this.responseMetrics.finishResult(native.outcome === "succeeded" ? native.result.status : "ERROR");
        if (!this.interruptRequested) this.settle(now, native);
      } catch (error) { this.protocolError = `agy stream-json 结果无效：${error instanceof Error ? error.message : String(error)}`; this.bounded?.stop(); this.process?.dispose(); }
    }
  }

  /** 从已确认原生会话的 JSONL 补取缺失的思考记录，并同步单步上下文占用与实际模型。 */
  private syncStepTranscript(update: JsonRecord, needsContext: boolean) {
    const id = this.sessionId;
    const stepIndex = update.step_index;
    if (!id || !isAgyConversationId(id) || typeof stepIndex !== "number") return;
    if (update.conversation_id !== undefined && update.conversation_id !== id) return;
    const restore = this.projector.missingThinking(stepIndex);
    if (!restore && !needsContext) return;
    this.thinkingTranscript ??= new AgyThinkingTranscript(transcriptPath(id));
    this.thinkingTranscript.request(stepIndex, (snapshot) => {
      if (restore && snapshot.thinking) {
        restore(snapshot.thinking);
        this.scheduleFlush();
      }
      if (!this.closed && (snapshot.usedTokens !== undefined || snapshot.model)) {
        if (this.updateStepContext(stepIndex, snapshot.usedTokens, snapshot.model)) this.emitState();
      }
    });
  }

  private contextUsage() {
    const effectiveModel = this.model ?? this.reportedModel ?? this.defaultModel;
    const windowTokens = this.acpContextWindowTokens ?? agyContextWindowTokens(effectiveModel, this.contextWindowOverrides);
    return agyContextUsage(this.contextUsedTokens, windowTokens);
  }

  private refreshContextUsage() {
    const context = this.contextUsage();
    const { contextUsedTokens: _u, contextWindowTokens: _w, contextUsedPercent: _p, ...rest } = this.usage ?? {};
    const next: ChatUsage = { ...rest, ...context };
    this.usage = Object.keys(next).length > 0 ? next : undefined;
  }

  private updateStepContext(stepIndex: number, usedTokens: number | undefined, model: string | undefined): boolean {
    if (stepIndex < this.lastContextStep) return false;
    this.lastContextStep = stepIndex;
    let changed = false;
    if (model && model !== this.reportedModel) {
      this.reportedModel = model;
      changed = true;
    }
    if (usedTokens !== undefined) {
      this.turnStepContextUpdated = true;
      if (usedTokens !== this.contextUsedTokens) {
        this.contextUsedTokens = usedTokens;
        changed = true;
      }
    }
    if (changed) this.refreshContextUsage();
    return changed;
  }

  /**
   * result.usage 是整个 conversation 的累计值（不是本轮）：本轮 = 与上一次 result 的差。
   * 没有上一次记录时（打开历史会话后的第一轮），只有 num_turns 为 1 才能确定累计值就是本轮。
   * 输出 Token 已包含思考 Token，输入包含缓存命中；单步回合尚未拿到步骤用量时可用本轮总量兜底上下文占用。
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
    if (!this.turnStepContextUpdated && this.turnResponseSteps <= 1 && turn.input + turn.output > 0) {
      this.contextUsedTokens = turn.input + turn.output;
    }
    this.usage = { ...this.contextUsage(), inputTokens: turn.input, outputTokens: turn.output };
  }

  private settle(at: number, result: Pick<TurnOutcome, "outcome" | "text">) {
    this.clearAcpNativeSettleTimer();
    this.acpNativeTurn = false;
    this.acpNativeHasOutput = false;
    this.bounded?.stop();
    this.rejectAllAcpPermissions(false);
    if (this.transport === "acp") {
      if (result.outcome === "succeeded") this.projector.acpFinishSegments(at);
      this.acpMetrics.finishTurn(result.outcome === "succeeded" ? "completed" : "interrupted");
    }
    this.lifecycle.finish({ ...result, ...(this.error ? { error: this.error } : {}), nativeSessionId: this.sessionId, ...(this.usage ? { usage: this.usage } : {}) });
    if (this.interruptRequested) this.projector.markInterrupted();
    this.interruptRequested = false;
    const keepRunning = this.transport === "acp" && !this.error && result.outcome === "succeeded"
      ? this.acpBackgroundTasks.runningToolIds()
      : undefined;
    this.projector.closeTurn(at, this.error ? "failed" : undefined, undefined, keepRunning);
    this.flushNow();
    this.setState(this.error ? "error" : "idle");
    this.host.onSettled(this);
  }

  // ───────────────────────── ACP 实时协议 ─────────────────────────

  private acpLaunchArgs(): string[] {
    const args = ["--add-dir", this.projectPath];
    if (this.permissionMode === "bypass") args.push("--dangerously-skip-permissions");
    return args;
  }

  private async sendAcp(text: string, images: readonly ImageInput[], files: readonly FileInput[]) {
    const turnToken = ++this.acpTurnToken;
    this.acpPromptInFlight = true;
    this.acpBackgroundTasks.clearForeground();
    this.acpSeenTools.clear();
    this.acpTerminalTools.clear();
    try {
      const acp = await this.ensureAcpProcess();
      if (!this.isBusy || this.interruptRequested || this.acpTurnToken !== turnToken) return;
      await this.syncAcpSettings(acp);
      if (!this.isBusy || this.interruptRequested || this.acpTurnToken !== turnToken) return;

      const promptText = withFileReferences(await withProjectFilePaths(text, this.projectPath), files);
      const blocks: JsonRecord[] = [];
      if (images.length > 0) {
        if (this.acpSupportsImage) {
          for (const image of images) blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
        } else {
          const paths = await this.saveImages(images);
          if (paths.length > 0) blocks.push({ type: "text", text: `${promptText}${uploadedImagesNote(paths)}` });
        }
      }
      if (promptText && (images.length === 0 || this.acpSupportsImage)) {
        blocks.push({ type: "text", text: promptText });
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: "" });

      if (!this.isBusy || this.interruptRequested || this.acpTurnToken !== turnToken) return;
      this.acpMetrics.beginTurn(String(turnToken));
      const result = await acp.request<unknown>("session/prompt", { sessionId: this.sessionId, prompt: blocks }, 0);
      if (!this.isBusy || this.acpTurnToken !== turnToken) return;
      const res = isRecord(result) ? result : {};
      const stopReason = typeof res.stopReason === "string" ? res.stopReason : "";
      if (this.interruptRequested || stopReason === "cancelled") {
        this.acpBackgroundTasks.clearForeground();
        this.settle(Date.now(), { outcome: "interrupted", text: this.projector.acpTurnText() });
        return;
      }
      // 后台任务尚未终结时 session/prompt 会提前返回 end_turn；将仍运行的工具晋升为后台任务持续跟踪。
      this.acpBackgroundTasks.promoteActiveToBackground();
      this.recordAcpTurnUsage(res.usage);
      this.settle(Date.now(), { outcome: "succeeded", text: this.projector.acpTurnText() });
    } catch (error) {
      if (this.isBusy && !this.interruptRequested && this.acpTurnToken === turnToken) {
        this.acpBackgroundTasks.clearForeground();
        this.fail(this.protocolError ?? (error instanceof Error ? error.message : String(error)));
      }
    } finally {
      if (this.acpTurnToken === turnToken) this.acpPromptInFlight = false;
    }
  }

  private async ensureAcpProcess(): Promise<AgyAcpProcess> {
    const signature = JSON.stringify(["acp", this.permissionMode === "bypass"]);
    if (this.acpProcess?.running && this.launchedWith === signature) return this.acpProcess;
    if (this.acpStarting) return this.acpStarting;
    this.acpProcess?.dispose();
    this.acpProcess = null;
    this.acpStarting = this.startAcpProcess(signature).finally(() => {
      this.acpStarting = null;
    });
    return this.acpStarting;
  }

  private async startAcpProcess(signature: string): Promise<AgyAcpProcess> {
    const acp = new AgyAcpProcess(await this.host.resolveLaunch(this.projectPath, this.acpLaunchArgs()));
    this.acpProcess = acp;
    this.clearAcpNativeSettleTimer();
    this.acpNativeTurn = false;
    this.acpNativeHasOutput = false;
    this.acpBackgroundTasks.reset();
    this.acpAppliedModel = undefined;
    this.acpAppliedEffort = undefined;
    this.acpAppliedMode = undefined;
    this.acpAvailableModels = new Set();
    let ready = false;
    acp.on("notification", (method: string, params: JsonRecord) => {
      if (this.acpProcess === acp) this.handleAcpNotification(method, params);
    });
    acp.on("request", (req: AgyAcpServerRequest) => {
      if (this.acpProcess === acp) this.handleAcpRequest(acp, req);
    });
    acp.on("protocolError", (reason: string) => {
      if (this.acpProcess === acp) this.protocolError = reason;
    });
    acp.on("exit", (reason: string) => {
      this.onAcpExit(acp, reason);
    });
    try {
      const initRes = await acp.request<unknown>("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "hcode", version: "0.4.0" },
      });
      const initObj = isRecord(initRes) ? initRes : {};
      const caps = isRecord(initObj.agentCapabilities) ? initObj.agentCapabilities : {};
      const promptCaps = isRecord(caps.promptCapabilities) ? caps.promptCapabilities : {};
      this.acpSupportsImage = promptCaps.image === true;

      let sessionRes: unknown;
      if (this.sessionId) {
        this.acpReplaying = true;
        try {
          sessionRes = await acp.request("session/load", { sessionId: this.sessionId, cwd: this.projectPath, mcpServers: [] });
        } finally {
          this.acpReplaying = false;
        }
      } else {
        sessionRes = await acp.request("session/new", { cwd: this.projectPath, mcpServers: [] });
      }
      const sessObj = isRecord(sessionRes) ? sessionRes : {};
      const returnedId = typeof sessObj.sessionId === "string" ? sessObj.sessionId : undefined;
      if (!this.sessionId) {
        if (!returnedId) throw new Error("agy acp 初始化会话身份缺失");
        this.sessionId = returnedId;
      } else if (returnedId && returnedId !== this.sessionId) {
        throw new Error("agy acp 初始化会话身份变化");
      }

      const models = isRecord(sessObj.models) ? sessObj.models : undefined;
      if (models) {
        for (const item of Array.isArray(models.availableModels) ? models.availableModels : []) {
          if (isRecord(item) && typeof item.modelId === "string" && item.modelId) this.acpAvailableModels.add(item.modelId);
        }
        if (typeof models.currentModelId === "string" && models.currentModelId && !this.reportedModel) {
          this.reportedModel = models.currentModelId;
          this.refreshContextUsage();
        }
      }
      const modes = isRecord(sessObj.modes) ? sessObj.modes : undefined;
      if (modes && typeof modes.currentModeId === "string") this.acpAppliedMode = modes.currentModeId;

      this.launchedWith = signature;
      ready = true;
      if (this.closed || this.interruptRequested) {
        acp.dispose();
        return acp;
      }
      this.emitState();
      return acp;
    } catch (error) {
      if (!ready && this.acpProcess === acp) acp.dispose();
      throw error;
    }
  }

  private async syncAcpSettings(acp: AgyAcpProcess) {
    if (!this.sessionId) return;
    const targetMode = this.permissionMode === "accept-edits" ? "accept-edits" : "default";
    if (this.acpAppliedMode !== targetMode) {
      await acp.request("session/set_mode", { sessionId: this.sessionId, modeId: targetMode });
      this.acpAppliedMode = targetMode;
    }
    if (this.model !== this.acpAppliedModel) {
      if (this.model) {
        if (this.acpAvailableModels.size === 0 || this.acpAvailableModels.has(this.model)) {
          await acp.request("session/set_model", { sessionId: this.sessionId, modelId: this.model });
        } else {
          await acp.request("session/set_config_option", { sessionId: this.sessionId, configId: "model", value: this.model });
        }
      }
      this.acpAppliedModel = this.model;
    }
    if (this.effort !== this.acpAppliedEffort) {
      if (this.effort) {
        await acp.request("session/set_config_option", { sessionId: this.sessionId, configId: "thought_level", value: this.effort });
      }
      this.acpAppliedEffort = this.effort;
    }
  }

  private onAcpExit(acp: AgyAcpProcess, reason: string) {
    if (this.acpProcess !== acp) return;
    this.acpProcess = null;
    this.clearAcpNativeSettleTimer();
    this.acpPromptInFlight = false;
    const wasNative = this.acpNativeTurn;
    this.acpNativeTurn = false;
    this.acpNativeHasOutput = false;
    this.rejectAllAcpPermissions(false);
    const bgChanged = this.acpBackgroundTasks.endProcess();
    if (!this.isBusy) {
      if (bgChanged && !this.closed) this.emitState();
      return;
    }
    if (this.interruptRequested) {
      if (wasNative) this.settleAcpNativeTurn("interrupted");
      else this.settle(Date.now(), { outcome: "interrupted", text: this.projector.acpTurnText() });
    } else {
      this.fail(this.protocolError ?? reason);
    }
  }

  private handleAcpNotification(method: string, params: JsonRecord) {
    if (method !== "session/update") return;
    if (typeof params.sessionId === "string" && this.sessionId && params.sessionId !== this.sessionId) return;
    const update = isRecord(params.update) ? params.update : null;
    if (!update) return;
    const kind = update.sessionUpdate;
    if (kind === "usage_update") {
      const used = typeof update.used === "number" && Number.isFinite(update.used) && update.used >= 0 ? update.used : undefined;
      const size = typeof update.size === "number" && Number.isFinite(update.size) && update.size > 0 ? update.size : undefined;
      let changed = false;
      if (used !== undefined && used !== this.contextUsedTokens) {
        this.contextUsedTokens = used;
        changed = true;
      }
      if (size !== undefined && size !== this.acpContextWindowTokens) {
        this.acpContextWindowTokens = size;
        changed = true;
      }
      if (changed) {
        this.refreshContextUsage();
        this.emitState();
      }
      if (this.acpNativeTurn && !this.acpPromptInFlight && !this.acpReplaying && this.isBusy && this.acpNativeHasOutput) {
        this.scheduleAcpNativeSettle();
      }
      return;
    }
    if (this.acpReplaying || this.closed) return;
    const now = Date.now();
    if (!this.isBusy) {
      if (this.acpPromptInFlight) return;
      if (kind === "tool_call" || kind === "tool_call_update") {
        const status = typeof update.status === "string" ? update.status : "";
        const terminal = isAcpTerminalToolStatus(status);
        if (terminal) {
          const tracked = this.acpBackgroundTasks.observeTool(update, now);
          this.projector.acpToolCall(update, now);
          this.recordAcpSubagent(update);
          this.flushNow();
          if (tracked.changed) this.emitState();
          return;
        }
        this.beginAcpNativeTurn();
      } else if (
        (kind === "agent_thought_chunk" || kind === "agent_message_chunk")
        && acpChunkText(update)
      ) {
        this.beginAcpNativeTurn();
      } else {
        return;
      }
    }

    let metricsChanged = false;
    switch (kind) {
      case "agent_thought_chunk": {
        const text = acpChunkText(update);
        if (text) {
          this.clearAcpNativeSettleTimer();
          if (this.acpNativeTurn) this.acpNativeHasOutput = true;
          if (this.acpBackgroundTasks.promoteActiveToBackground()) metricsChanged = true;
          if (this.acpMetrics.output(text)) metricsChanged = true;
          this.projector.acpThoughtChunk(text, now);
          this.scheduleFlush();
        }
        break;
      }
      case "agent_message_chunk": {
        const text = acpChunkText(update);
        if (text) {
          this.clearAcpNativeSettleTimer();
          if (this.acpNativeTurn) this.acpNativeHasOutput = true;
          if (this.acpBackgroundTasks.promoteActiveToBackground()) metricsChanged = true;
          if (this.acpMetrics.output(text)) metricsChanged = true;
          this.projector.acpMessageChunk(text, now);
          this.scheduleFlush();
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        this.clearAcpNativeSettleTimer();
        if (this.acpNativeTurn) this.acpNativeHasOutput = true;
        const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
        const status = typeof update.status === "string" ? update.status : "";
        const terminal = isAcpTerminalToolStatus(status);
        const tracked = this.acpBackgroundTasks.observeTool(update, now);
        if (tracked.changed) metricsChanged = true;
        if (toolCallId) {
          if (!this.acpSeenTools.has(toolCallId)) {
            this.acpSeenTools.add(toolCallId);
            if (!terminal) {
              if (this.acpMetrics.item("mcpToolCall", toolCallId, true)) metricsChanged = true;
            }
          } else if (terminal && !this.acpTerminalTools.has(toolCallId)) {
            this.acpTerminalTools.add(toolCallId);
            this.acpMetrics.item("mcpToolCall", toolCallId, false);
          }
        }
        this.projector.acpToolCall(update, now);
        this.recordAcpSubagent(update);
        this.scheduleFlush();
        break;
      }
      case "config_option_update": {
        const options = Array.isArray(update.configOptions) ? update.configOptions.filter(isRecord) : [];
        const modelOpt = options.find((opt) => opt.id === "model");
        if (modelOpt && typeof modelOpt.currentValue === "string" && modelOpt.currentValue && modelOpt.currentValue !== this.reportedModel) {
          this.reportedModel = modelOpt.currentValue;
          this.refreshContextUsage();
          metricsChanged = true;
        }
        break;
      }
      default:
        return;
    }
    if (metricsChanged) this.emitState();
  }

  /** 后台任务、定时器或子代理完成唤醒模型时，ACP 不经 send() 直接推送 session/update，自动开启原生回合。 */
  private beginAcpNativeTurn() {
    this.clearAcpNativeSettleTimer();
    this.acpTurnToken++;
    this.acpNativeTurn = true;
    this.acpNativeHasOutput = false;
    this.error = undefined;
    this.interruptRequested = false;
    this.acpSeenTools.clear();
    this.acpTerminalTools.clear();
    this.acpMetrics.start();
    this.acpMetrics.beginTurn(`native-${this.acpTurnToken}`);
    this.usage = this.contextUsage();
    this.setState("running");
  }

  /** ACP 原生唤醒回合没有二次 prompt response；收到 usage_update 且无阻塞工具/待审批后经短静默窗口结算。 */
  private scheduleAcpNativeSettle() {
    if (!this.acpNativeTurn || this.acpPromptInFlight || !this.isBusy || this.closed) return;
    if (this.acpBackgroundTasks.blockingCount > 0 || this.acpPendingPermissions.size > 0) return;
    this.clearAcpNativeSettleTimer();
    const token = this.acpTurnToken;
    this.acpNativeSettleTimer = setTimeout(() => {
      this.acpNativeSettleTimer = null;
      if (!this.acpNativeTurn || this.acpPromptInFlight || !this.isBusy || this.closed || this.acpTurnToken !== token) return;
      if (this.acpBackgroundTasks.blockingCount > 0 || this.acpPendingPermissions.size > 0) return;
      this.settleAcpNativeTurn("succeeded");
    }, this.acpNativeSettleMs);
  }

  private clearAcpNativeSettleTimer() {
    if (this.acpNativeSettleTimer) clearTimeout(this.acpNativeSettleTimer);
    this.acpNativeSettleTimer = null;
  }

  private settleAcpNativeTurn(outcome: "succeeded" | "interrupted") {
    this.clearAcpNativeSettleTimer();
    this.acpNativeTurn = false;
    this.acpNativeHasOutput = false;
    this.rejectAllAcpPermissions(false);
    const at = Date.now();
    if (outcome === "succeeded") {
      this.acpBackgroundTasks.promoteActiveToBackground();
      this.projector.acpFinishSegments(at);
    } else {
      this.acpBackgroundTasks.clearForeground();
    }
    this.acpMetrics.finishTurn(outcome === "succeeded" ? "completed" : "interrupted");
    if (this.interruptRequested || outcome === "interrupted") this.projector.markInterrupted();
    this.interruptRequested = false;
    const keepRunning = outcome === "succeeded" && !this.error
      ? this.acpBackgroundTasks.runningToolIds()
      : undefined;
    this.projector.closeTurn(at, this.error ? "failed" : undefined, undefined, keepRunning);
    this.flushNow();
    this.setState(this.error ? "error" : "idle");
    this.host.onSettled(this);
  }

  private recordAcpSubagent(update: JsonRecord) {
    if (!this.sessionId || update.name !== "invoke_subagent") return;
    const raw = isRecord(update.rawOutput) && typeof update.rawOutput.output === "string"
      ? update.rawOutput.output
      : typeof update.rawOutput === "string"
        ? update.rawOutput
        : "";
    if (!raw) return;
    const args = isRecord(update.args) ? update.args : isRecord(update.rawInput) ? update.rawInput : {};
    let added = false;
    for (const match of raw.matchAll(/"conversationId"\s*:\s*"([0-9a-f-]+)"/gi)) {
      const id = match[1]!;
      if (!isAgyConversationId(id) || id === this.sessionId || this.nativeSubagents.has(id)) continue;
      this.nativeSubagents.set(id, {
        id,
        parentId: this.sessionId,
        ...(typeof args.Role === "string" && args.Role ? { role: args.Role } : {}),
        ...(typeof args.TypeName === "string" && args.TypeName ? { nickname: args.TypeName } : {}),
      });
      added = true;
    }
    if (added) this.host.onSubagentsChanged?.(this);
  }

  private handleAcpRequest(acp: AgyAcpProcess, req: AgyAcpServerRequest) {
    if (req.method !== "session/request_permission") {
      acp.respondError(req.id, -32601, `不支持的 ACP 客户端方法: ${req.method}`);
      return;
    }
    const options = (Array.isArray(req.params.options) ? req.params.options : [])
      .filter(isRecord)
      .filter((opt): opt is AcpPermissionOption & JsonRecord => typeof opt.optionId === "string");
    if (!this.isBusy && !this.acpPromptInFlight && !this.acpReplaying && !this.closed && !this.interruptRequested) {
      this.beginAcpNativeTurn();
    }
    if (!this.isBusy || this.interruptRequested) {
      acp.respond(req.id, { outcome: { outcome: "cancelled" } });
      return;
    }
    if (this.acpNativeTurn) {
      this.clearAcpNativeSettleTimer();
      this.acpNativeHasOutput = true;
    }
    if (this.permissionMode === "bypass") {
      const allow = options.find((opt) => opt.kind === "allow_once") ?? options.find((opt) => opt.kind?.startsWith("allow")) ?? options[0];
      acp.respond(req.id, allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } });
      return;
    }
    const toolCall = isRecord(req.params.toolCall) ? req.params.toolCall : {};
    const toolCallId = typeof toolCall.toolCallId === "string" && toolCall.toolCallId ? toolCall.toolCallId : `perm-${req.id}`;
    const rawName = typeof toolCall.name === "string" && toolCall.name ? toolCall.name : (typeof toolCall.kind === "string" ? toolCall.kind : "tool");
    const rawArgs = isRecord(toolCall.args) ? toolCall.args : isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
    const { toolName, input } = projectAgyTool(rawName, rawArgs);
    const title = typeof toolCall.title === "string" && toolCall.title ? toolCall.title : undefined;
    const interactionId = randomUUID();
    const canAllowForSession = options.some((opt) => opt.kind === "allow_always");

    this.acpPendingPermissions.set(interactionId, { requestId: req.id, toolCallId, options });
    this.acpMetrics.approval(interactionId, true);
    this.projector.setToolPendingApproval(toolCallId, toolName, input, interactionId, Date.now());
    this.flushNow();
    this.setState("awaitingApproval");
    this.host.emitPermission?.({
      sessionKey: this.key,
      interactionId,
      toolUseId: toolCallId,
      toolName,
      input,
      ...(title ? { title } : {}),
      canAllowForSession,
    });
  }

  ownsInteraction(interactionId: string): boolean {
    return this.acpPendingPermissions.has(interactionId);
  }

  respondPermission(interactionId: string, decision: PermissionDecision): boolean {
    const entry = this.acpPendingPermissions.get(interactionId);
    if (!entry) return false;
    this.acpPendingPermissions.delete(interactionId);
    this.acpMetrics.approval(interactionId, false);
    const allowed = decision.decision === "allow" || decision.decision === "allowSession";
    let picked: AcpPermissionOption | undefined;
    if (decision.decision === "allowSession") {
      picked = entry.options.find((opt) => opt.kind === "allow_always") ?? entry.options.find((opt) => opt.kind === "allow_once");
    } else if (decision.decision === "allow") {
      picked = entry.options.find((opt) => opt.kind === "allow_once") ?? entry.options.find((opt) => opt.kind?.startsWith("allow"));
    } else {
      picked = entry.options.find((opt) => opt.kind === "reject_once") ?? entry.options.find((opt) => opt.kind?.startsWith("reject"));
    }
    this.acpProcess?.respond(
      entry.requestId,
      picked ? { outcome: { outcome: "selected", optionId: picked.optionId } } : { outcome: { outcome: "cancelled" } },
    );
    this.projector.resolveToolApproval(entry.toolCallId, allowed);
    this.flushNow();
    this.host.emitPermissionResolved?.({ sessionKey: this.key, interactionId });
    if (decision.decision === "deny" && decision.interrupt) void this.interrupt();
    if (this.acpPendingPermissions.size === 0 && this.state === "awaitingApproval") this.setState("running");
    return true;
  }

  private rejectAllAcpPermissions(cancelOnServer = false) {
    for (const [interactionId, entry] of this.acpPendingPermissions) {
      this.acpMetrics.approval(interactionId, false);
      if (cancelOnServer) {
        this.acpProcess?.respond(entry.requestId, { outcome: { outcome: "cancelled" } });
      }
      this.host.emitPermissionResolved?.({ sessionKey: this.key, interactionId });
    }
    this.acpPendingPermissions.clear();
  }

  private recordAcpTurnUsage(raw: unknown) {
    if (!isRecord(raw)) return;
    const inputBase = typeof raw.inputTokens === "number" && Number.isFinite(raw.inputTokens) && raw.inputTokens >= 0 ? raw.inputTokens : undefined;
    const output = typeof raw.outputTokens === "number" && Number.isFinite(raw.outputTokens) && raw.outputTokens >= 0 ? raw.outputTokens : undefined;
    if (inputBase === undefined || output === undefined) return;
    const cachedRead = typeof raw.cachedReadTokens === "number" && Number.isFinite(raw.cachedReadTokens) && raw.cachedReadTokens >= 0 ? raw.cachedReadTokens : 0;
    const cachedWrite = typeof raw.cachedWriteTokens === "number" && Number.isFinite(raw.cachedWriteTokens) && raw.cachedWriteTokens >= 0 ? raw.cachedWriteTokens : 0;
    const inputTokens = inputBase + cachedRead + cachedWrite;
    this.usage = { ...this.contextUsage(), inputTokens, outputTokens: output };
  }

  // ───────────────────────── 控制 ─────────────────────────

  async interrupt() {
    if (!this.isBusy) return;
    this.bounded?.stop();
    this.lifecycle.requestCancellation();
    this.interruptRequested = true;
    if (this.transport === "acp") {
      this.clearAcpNativeSettleTimer();
      this.rejectAllAcpPermissions(true);
      if (this.acpProcess) {
        if (this.acpLaunchedReady()) this.acpProcess.notify("session/cancel", { sessionId: this.sessionId });
        else this.acpProcess.dispose();
      }
      if (this.acpNativeTurn && !this.acpPromptInFlight) {
        this.settleAcpNativeTurn("interrupted");
      }
      return;
    }
    if (this.process) this.process.interrupt();
    // 启动中的进程在 init 后收到中断；不提前发出停止确认。
  }

  private acpLaunchedReady(): boolean {
    return Boolean(this.sessionId && !this.acpStarting);
  }

  async setPermissionMode(mode: PermissionMode) {
    this.permissionMode = mode; // 下一次发送时重启或通过 session/set_mode 生效
    this.emitState();
  }

  async setModel(model: string) {
    this.model = model || undefined;
    this.acpContextWindowTokens = undefined;
    this.refreshContextUsage();
    this.emitState();
  }

  async setEffort(effort: string) {
    this.effort = effort || undefined;
  }

  close() {
    this.closed = true;
    this.clearAcpNativeSettleTimer();
    this.acpNativeTurn = false;
    this.acpNativeHasOutput = false;
    this.acpPromptInFlight = false;
    this.thinkingTranscript?.close();
    if (this.isBusy) { this.lifecycle.requestCancellation(); this.interruptRequested = true; }
    this.rejectAllAcpPermissions(true);
    if (this.acpBackgroundTasks.endProcess()) this.emitState();
    this.bounded?.close();
    this.process?.dispose();
    this.acpProcess?.dispose();
  }

  private fail(message: string) {
    this.clearAcpNativeSettleTimer();
    this.acpNativeTurn = false;
    this.acpNativeHasOutput = false;
    this.acpBackgroundTasks.clearForeground();
    this.bounded?.stop();
    this.rejectAllAcpPermissions(false);
    this.lifecycle.finish({ outcome: "failed", text: "", error: message, nativeSessionId: this.sessionId });
    this.error = message;
    this.interruptRequested = false;
    this.projector.failTurn(`Antigravity 出错：${message}`, Date.now());
    this.flushNow();
    this.setState("error");
  }

  private setState(state: ChatRunState) {
    if (this.state === state) return;
    if (state === "idle" || state === "error") {
      this.activeMetrics().finish();
      this.thinkingTranscript?.endTurn();
    }
    if (state === "awaitingApproval") this.activeMetrics().endSegment();
    this.state = state;
    this.emitState();
  }

  emitState() {
    const model = this.model ?? this.reportedModel;
    const metrics = this.activeMetrics();
    const bgCount = this.transport === "acp" ? this.acpBackgroundTasks.count : 0;
    const bgDetails = this.transport === "acp" ? this.acpBackgroundTasks.snapshot() : undefined;
    this.host.emitState({
      sessionKey: this.key,
      agent: "agy",
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      projectPath: this.projectPath,
      state: this.state,
      ...(bgCount ? { backgroundTasks: bgCount } : {}),
      ...(bgDetails ? { backgroundTaskDetails: bgDetails } : {}),
      ...(this.error ? { error: this.error } : {}),
      permissionMode: this.permissionMode,
      ...(model ? { model } : {}),
      usage: { ...this.usage, ...metrics.snapshot(this.usage?.outputTokens), turnStatistics: metrics.turnStatistics() },
    });
  }

  /** 先发出已缓冲的增量，再返回当前全部行；远程端中途接入时作为快照。 */
  liveRows() {
    this.flushNow();
    return this.projector.snapshot();
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

function isAcpTerminalToolStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "error" || status === "cancelled" || status === "canceled";
}

function acpChunkText(update: JsonRecord): string {
  return isRecord(update.content) && update.content.type === "text" && typeof update.content.text === "string"
    ? update.content.text
    : "";
}
