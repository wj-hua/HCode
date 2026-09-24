// 一个正在进行的 StepCode / pi 会话：对应一个 `step --mode rpc`（或 `pi --mode rpc`）子进程。
// 权限模式与模型在启动参数里指定（step 的 /permissions、set_model 会改写全局配置，这里不用），
// 切换后下一次发送时带 --session 重启进程续上同一个会话文件。
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  ChatRunState,
  ChatStateEvent,
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
import type { PiVariant } from "./piVariant.js";
import { StepRpcProcess, type StepLaunch } from "./stepRpc.js";
import { activeBranch, StepRowProjector, type StepEntry, type StepMessage } from "./stepProjector.js";

const FLUSH_INTERVAL_MS = 16;

export interface StepSessionHost {
  resolveLaunch(cwd: string, args: string[]): Promise<StepLaunch>;
  emitRows(sessionKey: string, ops: RowOp[]): void;
  emitState(event: ChatStateEvent): void;
  emitPermission(event: PermissionRequestEvent): void;
  emitPermissionResolved(event: PermissionResolvedEvent): void;
  /** 一轮跑完：会话文件此时已写入，用于刷新会话列表。 */
  onSettled(session: StepSession): void;
}

interface PendingUi {
  uiId: string;
  kind: "confirm" | "question";
  toolCallId?: string;
  toolName?: string;
  question?: string;
}

export class StepSession {
  readonly key: string;
  readonly projectPath: string;
  sessionId: string | undefined;
  sessionFile: string | undefined;
  permissionMode: PermissionMode;
  model: string | undefined;
  /** 思考强度（--thinking），变化后下一次发送时重启进程生效。 */
  effort: string | undefined;
  /** step 实际使用的模型（get_state 返回）。 */
  private reportedModel: string | undefined;

  private readonly variant: PiVariant;
  private readonly projector: StepRowProjector;
  private process: StepRpcProcess | null = null;
  /** 当前进程启动时的参数，与现在的设置不同就要重启。 */
  private launchedWith = "";
  private state: ChatRunState = "idle";
  private error: string | undefined;
  private readonly pending = new Map<string, PendingUi>();
  /** “本会话总是允许”过的工具（危险命令除外）。 */
  private readonly allowedTools = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly host: StepSessionHost,
    options: {
      variant: PiVariant;
      key: string;
      projectPath: string;
      sessionId?: string;
      sessionFile?: string;
      permissionMode: PermissionMode;
      model?: string;
    },
  ) {
    this.variant = options.variant;
    this.projector = new StepRowProjector(options.variant.projectTool, options.variant.name);
    this.key = options.key;
    this.projectPath = options.projectPath;
    this.sessionId = options.sessionId;
    this.sessionFile = options.sessionFile;
    this.permissionMode = options.permissionMode;
    this.model = options.model || undefined;
  }

  get isBusy(): boolean {
    return this.state === "running" || this.state === "awaitingApproval";
  }

  seedHistory(entries: readonly StepEntry[]) {
    for (const entry of activeBranch(entries)) this.projector.consumeEntry(entry);
    const last = entries.at(-1)?.timestamp;
    this.projector.closeTurn(last ? Date.parse(last) || Date.now() : Date.now());
    this.projector.drain();
    this.host.emitRows(this.key, [{ op: "reset", rows: this.projector.snapshot() }]);
  }

  async send(text: string, images: readonly ImageInput[] = [], files: readonly FileInput[] = []) {
    if (this.closed) throw new Error("会话已关闭");
    this.error = undefined;
    this.projector.beginLocalTurn(text, Date.now(), images, files);
    this.flushNow();
    this.setState("running");
    try {
      const rpc = await this.ensureProcess();
      await rpc.request("prompt", {
        message: withFileReferences(text, files),
        ...(images.length
          ? { images: images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })) }
          : {}),
      });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private launchArgs(): string[] {
    const args = this.variant.launchArgs(this.permissionMode);
    if (this.model) args.push("--model", this.model);
    if (this.effort) args.push("--thinking", this.effort);
    if (this.sessionFile && existsSync(this.sessionFile)) args.push("--session", this.sessionFile);
    else if (this.sessionId) args.push("--session-id", this.sessionId);
    return args;
  }

  private async ensureProcess(): Promise<StepRpcProcess> {
    const signature = JSON.stringify([this.permissionMode, this.model ?? "", this.effort ?? ""]);
    if (this.process?.running && this.launchedWith === signature) return this.process;
    this.process?.dispose();
    const rpc = new StepRpcProcess(await this.host.resolveLaunch(this.projectPath, this.launchArgs()));
    this.process = rpc;
    this.launchedWith = signature;
    rpc.on("event", (event: JsonRecord) => {
      if (this.process === rpc) this.handleEvent(event);
    });
    rpc.on("exit", (reason: string) => {
      if (this.process !== rpc) return;
      this.process = null;
      if (this.isBusy) this.fail(reason);
    });
    const state = await rpc.request<JsonRecord>("get_state");
    if (typeof state.sessionId === "string") this.sessionId = state.sessionId;
    if (typeof state.sessionFile === "string") this.sessionFile = state.sessionFile;
    const model = isRecord(state.model) ? state.model : null;
    if (model) this.reportedModel = `${String(model.provider)}/${String(model.id)}`;
    this.emitState();
    return rpc;
  }

  // ───────────────────────── 事件处理 ─────────────────────────

  private handleEvent(event: JsonRecord) {
    const now = Date.now();
    switch (event.type) {
      case "message_start":
        if (isRecord(event.message) && event.message.role === "assistant") this.projector.beginAssistantMessage(now);
        break;
      case "message_update":
        if (isRecord(event.assistantMessageEvent)) this.projector.streamEvent(event.assistantMessageEvent, now);
        break;
      case "message_end": {
        if (!isRecord(event.message)) break;
        const message = event.message as StepMessage;
        this.projector.consumeMessage(message, now);
        if (message.role === "assistant" && message.stopReason === "error") {
          this.error = typeof message.errorMessage === "string" ? message.errorMessage : `${this.variant.name} 执行出错`;
        }
        break;
      }
      case "tool_execution_update":
        this.projector.toolProgress(String(event.toolCallId ?? ""), event.partialResult);
        break;
      case "auto_retry_end":
        if (event.success === true) this.error = undefined;
        break;
      case "compaction_end":
        if (event.result) this.projector.compacted(now);
        break;
      case "extension_ui_request":
        this.handleUiRequest(event);
        return;
      case "agent_settled":
        this.settle(now);
        return;
      default:
        return;
    }
    this.scheduleFlush();
  }

  private settle(at: number) {
    this.projector.closeTurn(at, this.error ? "failed" : undefined);
    this.cancelAllPending();
    this.flushNow();
    this.setState(this.error ? "error" : "idle");
    this.host.onSettled(this);
  }

  // ───────────────────────── 审批与提问 ─────────────────────────

  /** step 的审批与提问都是扩展 UI 对话框：confirm（工具审批）、select / input / editor（提问）。 */
  private handleUiRequest(request: JsonRecord) {
    const uiId = String(request.id ?? "");
    const title = typeof request.title === "string" ? request.title : "";
    const interactionId = randomUUID();
    let event: PermissionRequestEvent;
    let entry: PendingUi;
    switch (request.method) {
      case "confirm": {
        // 工具审批的标题形如 “Approve run_command [6ac95177]”，正文第一行是 “Call: <toolCallId>”，第二行是原因
        const message = typeof request.message === "string" ? request.message : "";
        const head = /^(Approve|Dangerous) (\S+) \[/.exec(title);
        const lines = message.split("\n");
        const toolCallId = /^Call: (\S+)/.exec(lines[0] ?? "")?.[1];
        const dangerous = head?.[1] === "Dangerous";
        const rawTool = head?.[2];
        if (rawTool && !dangerous && this.allowedTools.has(rawTool)) {
          this.process?.respondUi(uiId, { confirmed: true });
          return;
        }
        const known = toolCallId ? this.projector.toolInput(toolCallId) : undefined;
        entry = { uiId, kind: "confirm", ...(toolCallId ? { toolCallId } : {}), ...(rawTool ? { toolName: rawTool } : {}) };
        event = {
          sessionKey: this.key,
          interactionId,
          toolUseId: toolCallId ?? interactionId,
          toolName: known?.toolName ?? rawTool ?? "confirm",
          input: known?.input ?? { message },
          ...(head ? {} : { title }),
          ...(dangerous ? { description: "危险操作" } : {}),
          ...(head && lines[1] ? { decisionReason: lines[1] } : {}),
          canAllowForSession: Boolean(rawTool) && !dangerous,
          ...(dangerous ? { defaultToNo: true } : {}),
        };
        break;
      }
      case "select":
      case "input":
      case "editor": {
        const options = Array.isArray(request.options) ? request.options.map(String) : [];
        const question = title || "请输入";
        entry = { uiId, kind: "question", question };
        event = {
          sessionKey: this.key,
          interactionId,
          toolUseId: interactionId,
          toolName: "AskUserQuestion",
          input: {
            questions: [
              { question, header: "", options: options.map((label) => ({ label, description: "" })), multiSelect: false },
            ],
          },
          canAllowForSession: false,
        };
        break;
      }
      default:
        // notify / setStatus / setWidget 等无需回复的请求
        return;
    }
    this.pending.set(interactionId, entry);
    if (entry.toolCallId) {
      this.projector.setToolPendingApproval(entry.toolCallId, event.toolName, event.input, interactionId, Date.now());
      this.flushNow();
    }
    this.setState("awaitingApproval");
    this.host.emitPermission(event);
  }

  ownsInteraction(interactionId: string): boolean {
    return this.pending.has(interactionId);
  }

  respondPermission(interactionId: string, decision: PermissionDecision) {
    const entry = this.pending.get(interactionId);
    if (!entry) return;
    this.pending.delete(interactionId);
    const allowed = decision.decision === "allow" || decision.decision === "allowSession";
    if (entry.kind === "confirm") {
      if (decision.decision === "allowSession" && entry.toolName) this.allowedTools.add(entry.toolName);
      this.process?.respondUi(entry.uiId, { confirmed: allowed });
      // step 的 confirm 只能回是/否；拒绝理由作为插话消息发给模型（在下一次调用模型前送达）
      if (decision.decision === "deny" && decision.message && !decision.interrupt) {
        void this.process?.request("steer", { message: decision.message }).catch(() => undefined);
      }
    } else {
      const answers =
        decision.decision === "allow" && isRecord(decision.updatedInput?.answers)
          ? (decision.updatedInput.answers as Record<string, string>)
          : {};
      const value = entry.question ? answers[entry.question] : undefined;
      this.process?.respondUi(entry.uiId, value ? { value } : { cancelled: true });
    }
    if (entry.toolCallId) {
      this.projector.resolveToolApproval(entry.toolCallId, allowed);
      this.flushNow();
    }
    this.host.emitPermissionResolved({ sessionKey: this.key, interactionId });
    if (decision.decision === "deny" && decision.interrupt) void this.interrupt();
    if (this.pending.size === 0 && this.state === "awaitingApproval") this.setState("running");
  }

  private cancelAllPending() {
    for (const [interactionId, entry] of this.pending) {
      this.process?.respondUi(entry.uiId, { cancelled: true });
      this.host.emitPermissionResolved({ sessionKey: this.key, interactionId });
    }
    this.pending.clear();
  }

  // ───────────────────────── 控制 ─────────────────────────

  async interrupt() {
    if (!this.isBusy) return;
    this.projector.markInterrupted();
    this.cancelAllPending();
    try {
      await this.process?.request("abort");
    } catch {
      // 进程已退出时忽略
    }
  }

  /** 进程在运行时直接改名（避免两个进程同时写会话文件）；返回 false 表示需要调用方另起进程。 */
  async rename(title: string): Promise<boolean> {
    if (!this.process?.running) return false;
    await this.process.request("set_session_name", { name: title });
    return true;
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
    this.cancelAllPending();
    this.process?.dispose();
    this.process = null;
  }

  private fail(message: string) {
    this.error = message;
    this.projector.failTurn(`${this.variant.name} 出错：${message}`, Date.now());
    this.cancelAllPending();
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
      agent: this.variant.kind,
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
