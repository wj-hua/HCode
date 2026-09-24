// 一个正在进行的 Claude 会话：包装 SDK query()（流式输入模式，同一进程内多轮对话）。
import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type EffortLevel,
  type PermissionMode as ClaudePermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
import { inputAttachments } from "../rowProjectorBase.js";
import { withFileReferences } from "../fileAttachments.js";
import { ClaudeRowProjector, type ClaudeRecord } from "./rowProjector.js";

const IDLE_CLOSE_MS = 10 * 60 * 1000;
const FLUSH_INTERVAL_MS = 16;

export interface ClaudeSessionHost {
  claudePath: string;
  env: Record<string, string>;
  emitRows(sessionKey: string, ops: RowOp[]): void;
  emitState(event: ChatStateEvent): void;
  emitPermission(event: PermissionRequestEvent): void;
  emitPermissionResolved(event: PermissionResolvedEvent): void;
  onSessionId(sessionKey: string, sessionId: string, projectPath: string): void;
  /** 一轮结束或收到 rate_limit_event：额度可能变了。 */
  onQuotaChanged(): void;
}

/** 可以不断 push 的 AsyncIterable，作为 SDK 的流式输入。 */
class InputQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((result: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(item: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end() {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface PendingPermission {
  toolUseId: string;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
}

export class ClaudeSession {
  readonly key: string;
  readonly projectPath: string;
  sessionId: string | undefined;
  permissionMode: PermissionMode;
  model: string | undefined;
  effort: string | undefined;

  private readonly projector = new ClaudeRowProjector();
  private activeQuery: Query | null = null;
  private input: InputQueue<SDKUserMessage> | null = null;
  private state: ChatRunState = "idle";
  private error: string | undefined;
  private readonly pending = new Map<string, PendingPermission>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly host: ClaudeSessionHost,
    options: {
      key: string;
      projectPath: string;
      resumeSessionId?: string;
      permissionMode: PermissionMode;
      model?: string;
      effort?: string;
    },
  ) {
    this.key = options.key;
    this.projectPath = options.projectPath;
    this.sessionId = options.resumeSessionId;
    this.permissionMode = options.permissionMode;
    this.model = options.model || undefined;
    this.effort = options.effort || undefined;
  }

  /** 续聊时先把历史喂给投影器，保证新行的 rowId 接在历史后面。 */
  seedHistory(records: readonly ClaudeRecord[]) {
    let lastAt = 0;
    for (const record of records) {
      this.projector.consume(record);
      const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
      if (Number.isFinite(at)) lastAt = Math.max(lastAt, at);
    }
    this.projector.closeTurn(lastAt || Date.now());
    this.projector.drain();
    this.host.emitRows(this.key, [{ op: "reset", rows: this.projector.snapshot() }]);
  }

  get isBusy(): boolean {
    return this.state === "running" || this.state === "awaitingApproval";
  }

  send(text: string, images: readonly ImageInput[] = [], files: readonly FileInput[] = []) {
    if (this.closed) throw new Error("会话已关闭");
    this.clearIdleTimer();
    this.error = undefined;
    this.projector.beginUserTurn(text, Date.now(), undefined, inputAttachments(images, files));
    this.flushNow();
    if (!this.activeQuery) this.start();
    // 有图片时用 Anthropic 的内容块数组；空文本块会被 API 拒绝，所以只在有文字时带上
    const prompt = withFileReferences(text, files);
    const content = images.length
      ? [
          ...images.map((image) => ({
            type: "image",
            source: { type: "base64", media_type: image.mimeType, data: image.data },
          })),
          ...(prompt.trim() ? [{ type: "text", text: prompt }] : []),
        ]
      : prompt;
    this.input!.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    this.setState("running");
  }

  private start() {
    const input = new InputQueue<SDKUserMessage>();
    this.input = input;
    const permissionMode = this.permissionMode;
    this.activeQuery = query({
      prompt: input,
      options: {
        cwd: this.projectPath,
        ...(this.sessionId ? { resume: this.sessionId } : {}),
        pathToClaudeCodeExecutable: this.host.claudePath,
        env: this.host.env,
        permissionMode: permissionMode as ClaudePermissionMode,
        // 允许用户在会话中途切换到“完全放行”；是否真的放行仍由 permissionMode 决定
        allowDangerouslySkipPermissions: true,
        canUseTool: this.canUseTool,
        includePartialMessages: true,
        thinking: { type: "adaptive", display: "summarized" },
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort as EffortLevel } : {}),
        stderr: (data: string) => {
          if (process.env.HCODE_DEBUG) process.stderr.write(`[claude] ${data}`);
        },
      },
    });
    void this.pump(this.activeQuery);
  }

  private async pump(activeQuery: Query) {
    try {
      for await (const message of activeQuery) {
        this.handleMessage(message);
      }
    } catch (error) {
      if (!this.closed) {
        const message = error instanceof Error ? error.message : String(error);
        this.projector.failTurn(`Claude 进程异常：${message}`, Date.now());
        this.error = message;
      }
    } finally {
      if (this.activeQuery === activeQuery) {
        this.activeQuery = null;
        this.input = null;
      }
      this.rejectAllPending("会话已结束");
      if (this.projector.hasOpenTurn) this.projector.closeTurn(Date.now(), this.error ? "failed" : undefined);
      this.flushNow();
      if (!this.closed) this.setState(this.error ? "error" : "idle");
    }
  }

  private handleMessage(message: SDKMessage) {
    if (message.type === "system" && message.subtype === "init") {
      if (message.session_id && message.session_id !== this.sessionId) {
        this.sessionId = message.session_id;
        this.host.onSessionId(this.key, message.session_id, this.projectPath);
      }
      if (message.model) this.model = message.model;
      this.emitState();
    }
    if (message.type === "rate_limit_event") this.host.onQuotaChanged();
    this.projector.consume(message as unknown as ClaudeRecord);
    if (message.type === "result") {
      this.host.onQuotaChanged();
      this.flushNow();
      if (this.pending.size === 0) this.setState("idle");
      this.scheduleIdleClose();
      return;
    }
    this.scheduleFlush();
  }

  private readonly canUseTool: CanUseTool = (toolName, input, options) => {
    const interactionId = randomUUID();
    this.projector.setToolPendingApproval(
      options.toolUseID,
      toolName,
      input,
      interactionId,
      Date.now(),
    );
    this.flushNow();
    this.setState("awaitingApproval");
    const suggestions = options.suggestions ?? [];
    this.host.emitPermission({
      sessionKey: this.key,
      interactionId,
      toolUseId: options.toolUseID,
      toolName,
      input,
      ...(options.title ? { title: options.title } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.decisionReason ? { decisionReason: options.decisionReason } : {}),
      ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
      canAllowForSession: suggestions.length > 0 && !options.suppressAlwaysAllowRule,
      ...(options.defaultToNo ? { defaultToNo: true } : {}),
    });
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(interactionId, {
        toolUseId: options.toolUseID,
        input,
        suggestions,
        resolve,
      });
      options.signal.addEventListener(
        "abort",
        () => this.settlePermission(interactionId, { behavior: "deny", message: "已取消" }, false),
        { once: true },
      );
    });
  };

  respondPermission(interactionId: string, decision: PermissionDecision) {
    const pending = this.pending.get(interactionId);
    if (!pending) return;
    let result: PermissionResult;
    switch (decision.decision) {
      case "allow":
        result = {
          behavior: "allow",
          updatedInput: decision.updatedInput ?? pending.input,
          decisionClassification: "user_temporary",
        };
        break;
      case "allowSession":
        result = {
          behavior: "allow",
          updatedInput: pending.input,
          updatedPermissions: pending.suggestions.map((update) => ({
            ...update,
            destination: "session",
          })),
          decisionClassification: "user_permanent",
        };
        break;
      default:
        result = {
          behavior: "deny",
          message: decision.message?.trim() || "用户拒绝了这次操作",
          ...(decision.interrupt ? { interrupt: true } : {}),
          decisionClassification: "user_reject",
        };
        if (decision.interrupt) this.projector.markInterrupted();
        break;
    }
    this.settlePermission(interactionId, result, result.behavior === "allow");
  }

  private settlePermission(interactionId: string, result: PermissionResult, allowed: boolean) {
    const pending = this.pending.get(interactionId);
    if (!pending) return;
    this.pending.delete(interactionId);
    this.projector.resolveToolApproval(pending.toolUseId, allowed);
    this.flushNow();
    pending.resolve(result);
    this.host.emitPermissionResolved({ sessionKey: this.key, interactionId });
    if (this.pending.size === 0 && this.state === "awaitingApproval") this.setState("running");
  }

  private rejectAllPending(message: string) {
    for (const id of [...this.pending.keys()]) {
      this.settlePermission(id, { behavior: "deny", message }, false);
    }
  }

  async interrupt() {
    if (!this.isBusy) return;
    this.projector.markInterrupted();
    this.rejectAllPending("用户已停止");
    try {
      await this.activeQuery?.interrupt();
    } catch {
      // 进程已退出时忽略
    }
  }

  async setPermissionMode(mode: PermissionMode) {
    this.permissionMode = mode;
    this.emitState();
    try {
      await this.activeQuery?.setPermissionMode(mode as ClaudePermissionMode);
    } catch {
      // bypassPermissions 需要启动时声明；运行中切换失败则在下次启动时生效
    }
  }

  async setModel(model: string) {
    this.model = model || undefined;
    this.emitState();
    try {
      await this.activeQuery?.setModel(model || undefined);
    } catch {
      // 下次启动时生效
    }
  }

  async setEffort(effort: string) {
    this.effort = effort || undefined;
    try {
      await this.activeQuery?.applyFlagSettings({ effortLevel: (effort || null) as EffortLevel | null });
    } catch {
      // 下次启动时生效
    }
  }

  close() {
    this.closed = true;
    this.clearIdleTimer();
    this.rejectAllPending("会话已关闭");
    this.input?.end();
    this.activeQuery?.close();
    this.activeQuery = null;
    this.input = null;
  }

  // ───────────────────────── 内部工具 ─────────────────────────

  private scheduleIdleClose() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.isBusy) return;
      // 空闲时释放子进程；下次发送会自动用 resume 重建
      this.input?.end();
      this.activeQuery?.close();
      this.activeQuery = null;
      this.input = null;
    }, IDLE_CLOSE_MS);
  }

  private clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private setState(state: ChatRunState) {
    if (this.state === state) return;
    this.state = state;
    this.emitState();
  }

  emitState() {
    this.host.emitState({
      sessionKey: this.key,
      agent: "claude",
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      projectPath: this.projectPath,
      state: this.state,
      ...(this.error ? { error: this.error } : {}),
      permissionMode: this.permissionMode,
      ...(this.model ? { model: this.model } : {}),
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
