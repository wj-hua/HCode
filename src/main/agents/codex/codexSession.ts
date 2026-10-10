// 一个正在进行的 Codex 会话（对应 app-server 的一个 thread）。
import { randomUUID } from "node:crypto";
import type {
  ChatRunState,
  PermissionDecision,
  PermissionMode,
  RowOp,
  ChatStateEvent,
  ChatUsage,
  FileInput,
  ImageInput,
  PermissionRequestEvent,
  PermissionResolvedEvent,
} from "../../../shared/types.js";
import { isRecord } from "../rowProjectorBase.js";
import { CodexResponseMetrics } from "./codexResponseMetrics.js";
import { withFileReferences } from "../fileAttachments.js";
import type { AppServerClient, ServerRequest } from "./appServerClient.js";
import { CodexRowProjector, type CodexItem, type CodexTurn } from "./codexProjector.js";

const FLUSH_INTERVAL_MS = 16;

interface InvokedSkill {
  name: string;
  path: string;
}

/** HCode 权限模式 → codex 的审批策略 + 沙箱。 */
export function codexPolicy(mode: PermissionMode) {
  switch (mode) {
    case "untrusted":
      return { approvalPolicy: "untrusted", sandbox: "workspace-write" } as const;
    case "read-only":
      return { approvalPolicy: "on-request", sandbox: "read-only" } as const;
    case "full-access":
      return { approvalPolicy: "never", sandbox: "danger-full-access" } as const;
    default:
      return { approvalPolicy: "on-request", sandbox: "workspace-write" } as const;
  }
}

function sandboxPolicyObject(sandbox: ReturnType<typeof codexPolicy>["sandbox"]) {
  switch (sandbox) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      return {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

export interface CodexSessionHost {
  client: AppServerClient;
  emitRows(sessionKey: string, ops: RowOp[]): void;
  emitState(event: ChatStateEvent): void;
  emitPermission(event: PermissionRequestEvent): void;
  emitPermissionResolved(event: PermissionResolvedEvent): void;
  onThreadId(session: CodexSession): void;
  /** 一轮结束：thread 此时才写入 codex 的索引，用于刷新会话列表（标题也可能已更新）。 */
  onTurnCompleted(session: CodexSession): void;
}

interface PendingRequest {
  request: ServerRequest;
  kind: "command" | "fileChange" | "userInput" | "permissions";
  itemId: string;
  questions?: { id: string; question: string }[];
}

export class CodexSession {
  readonly key: string;
  readonly projectPath: string;
  threadId: string | undefined;
  permissionMode: PermissionMode;
  model: string | undefined;
  /** 思考强度，随每轮 turn/start 发送。 */
  effort: string | undefined;
  /** app-server 实际使用的模型（thread/start、thread/resume 返回）。 */
  private reportedModel: string | undefined;

  private readonly projector = new CodexRowProjector();
  private state: ChatRunState = "idle";
  private error: string | undefined;
  private attached = false;
  private currentTurnId: string | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private usage: ChatUsage | undefined;
  private readonly responseMetrics = new CodexResponseMetrics();
  private totalInputTokens: number | null = null;
  private totalOutputTokens: number | null = null;

  constructor(
    private readonly host: CodexSessionHost,
    options: { key: string; projectPath: string; threadId?: string; permissionMode: PermissionMode; model?: string },
  ) {
    this.key = options.key;
    this.projectPath = options.projectPath;
    this.threadId = options.threadId;
    this.permissionMode = options.permissionMode;
    this.model = options.model || undefined;
  }

  get isBusy(): boolean {
    return this.state === "running" || this.state === "awaitingApproval";
  }

  seedHistory(turns: readonly CodexTurn[]) {
    for (const turn of turns) this.projector.consumeTurn(turn);
    this.projector.drain();
    this.host.emitRows(this.key, [{ op: "reset", rows: this.projector.snapshot() }]);
  }

  async send(text: string, images: readonly ImageInput[] = [], files: readonly FileInput[] = [], skill?: InvokedSkill) {
    if (this.closed) throw new Error("会话已关闭");
    this.error = undefined;
    this.currentTurnId = null;
    this.responseMetrics.start();
    this.usage = this.usage ? {
      contextUsedTokens: this.usage.contextUsedTokens,
      contextWindowTokens: this.usage.contextWindowTokens,
      contextUsedPercent: this.usage.contextUsedPercent,
    } : undefined;
    this.projector.beginLocalTurn(text, Date.now(), images, files);
    this.flushNow();
    this.setState("running");
    try {
      await this.attach();
      if (/^\/compact\s*$/i.test(text)) {
        if (images.length || files.length) throw new Error("/compact 不能附带文件或图片");
        await this.host.client.request("thread/compact/start", { threadId: this.threadId });
        return;
      }
      const review = /^\/review(?:\s+([\s\S]*))?$/i.exec(text.trim());
      if (review) {
        if (images.length || files.length) throw new Error("/review 不能附带文件或图片");
        const instructions = review[1]?.trim();
        const result = await this.host.client.request<{ turn: { id: string } }>("review/start", {
          threadId: this.threadId,
          delivery: "inline",
          target: instructions ? { type: "custom", instructions } : { type: "uncommittedChanges" },
        });
        this.currentTurnId = result.turn.id;
        return;
      }
      const policy = codexPolicy(this.permissionMode);
      const skillPrompt = skill ? text.replace(/^\s*\/[^\s]+/, `$${skill.name}`) : text;
      const prompt = withFileReferences(skillPrompt, files);
      const result = await this.host.client.request<{ turn: { id: string } }>("turn/start", {
        threadId: this.threadId,
        input: [
          ...(prompt.trim() || images.length === 0 ? [{ type: "text", text: prompt, text_elements: [] }] : []),
          ...(skill ? [{ type: "skill", name: skill.name, path: skill.path }] : []),
          ...images.map((image) => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` })),
        ],
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: sandboxPolicyObject(policy.sandbox),
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
        summary: "auto",
      });
      this.currentTurnId = result.turn.id;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** 新会话 thread/start；历史会话 thread/resume（只取元数据，历史已由 seedHistory 填充）。 */
  private async attach() {
    await this.host.client.ensureStarted();
    if (this.attached && this.threadId) return;
    const policy = codexPolicy(this.permissionMode);
    const common = {
      cwd: this.projectPath,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      ...(this.model ? { model: this.model } : {}),
    };
    if (this.threadId) {
      const result = await this.host.client.request<{ model?: string }>("thread/resume", {
        threadId: this.threadId,
        ...common,
        excludeTurns: true,
      });
      this.reportedModel = result.model;
    } else {
      const result = await this.host.client.request<{ thread: { id: string }; model?: string }>(
        "thread/start",
        common,
      );
      this.threadId = result.thread.id;
      this.reportedModel = result.model;
      this.host.onThreadId(this);
    }
    this.attached = true;
    this.emitState();
  }

  /** app-server 退出后需要重新 resume。 */
  detach(reason: string) {
    this.attached = false;
    if (this.isBusy) this.fail(reason);
  }

  // ───────────────────────── 通知处理 ─────────────────────────

  handleNotification(method: string, params: Record<string, unknown>) {
    const now = Date.now();
    if (method === "turn/started" && isRecord(params.turn) && typeof params.turn.id === "string") {
      if (!this.responseMetrics.beginTurn(params.turn.id)) return;
      this.currentTurnId = params.turn.id;
    }
    const turnId = params.turnId ?? (isRecord(params.turn) ? params.turn.id : undefined);
    if (typeof turnId === "string" && this.currentTurnId && turnId !== this.currentTurnId) return;
    const metricsTurn = this.responseMetrics.acceptsTurn(turnId);
    if (method === "thread/tokenUsage/updated" && !metricsTurn) return;
    if (metricsTurn && (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta" ||
      method === "item/reasoning/textDelta")) {
      if (this.responseMetrics.output(params.delta)) this.emitState();
    }
    if (metricsTurn && (method === "item/started" || method === "item/completed") && isRecord(params.item) &&
      typeof params.item.type === "string" && typeof params.item.id === "string") {
      this.responseMetrics.item(params.item.type, params.item.id, method === "item/started");
    }
    switch (method) {
      case "thread/tokenUsage/updated": {
        const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
        const total = tokenUsage && isRecord(tokenUsage.total) ? tokenUsage.total : null;
        const last = tokenUsage && isRecord(tokenUsage.last) ? tokenUsage.last : null;
        if (!total || !last) break;
        const totalInput = total.inputTokens;
        const totalOutput = total.outputTokens;
        const lastInput = last.inputTokens;
        const lastOutput = last.outputTokens;
        if (typeof totalInput !== "number" || !Number.isFinite(totalInput) || totalInput < 0 ||
          typeof totalOutput !== "number" || !Number.isFinite(totalOutput) || totalOutput < 0 ||
          typeof lastInput !== "number" || !Number.isFinite(lastInput) || lastInput < 0 ||
          typeof lastOutput !== "number" || !Number.isFinite(lastOutput) || lastOutput < 0) break;
        const inputDelta = this.totalInputTokens === null || totalInput < this.totalInputTokens
          ? lastInput : totalInput - this.totalInputTokens;
        const outputDelta = this.totalOutputTokens === null || totalOutput < this.totalOutputTokens
          ? lastOutput : totalOutput - this.totalOutputTokens;
        this.totalInputTokens = totalInput;
        this.totalOutputTokens = totalOutput;
        const window = tokenUsage?.modelContextWindow;
        const contextUsed = lastInput + lastOutput;
        this.usage = {
          inputTokens: (this.usage?.inputTokens ?? 0) + inputDelta,
          outputTokens: (this.usage?.outputTokens ?? 0) + outputDelta,
          ...(typeof window === "number" && window > 0 && contextUsed > 0 ? {
            contextUsedTokens: contextUsed,
            contextWindowTokens: window,
            contextUsedPercent: contextUsed / window * 100,
          } : {}),
        };
        this.emitState();
        return;
      }
      case "turn/started": {
        const turn = isRecord(params.turn) ? params.turn : null;
        if (turn && typeof turn.id === "string") this.currentTurnId = turn.id;
        break;
      }
      case "item/started":
        if (isRecord(params.item)) this.projector.itemStarted(params.item as CodexItem, now);
        break;
      case "item/completed":
        if (isRecord(params.item)) this.projector.itemCompleted(params.item as CodexItem, now);
        break;
      case "item/agentMessage/delta":
        this.projector.appendText(String(params.itemId), String(params.delta ?? ""));
        break;
      case "item/reasoning/summaryTextDelta":
        this.projector.appendText(String(params.itemId), String(params.delta ?? ""));
        break;
      case "item/reasoning/summaryPartAdded":
        this.projector.appendText(String(params.itemId), "", "\n\n");
        break;
      case "item/commandExecution/outputDelta":
        this.projector.appendToolOutput(String(params.itemId), String(params.delta ?? ""));
        break;
      case "turn/plan/updated":
        this.projector.updatePlan(params.plan, now);
        break;
      case "turn/completed": {
        const turn = (isRecord(params.turn) ? params.turn : {}) as Partial<CodexTurn>;
        if (metricsTurn) this.responseMetrics.finishTurn(turn.status ?? "completed", turn.durationMs);
        this.projector.finishTurn(
          { status: turn.status ?? "completed", durationMs: turn.durationMs ?? null, error: turn.error ?? null },
          now,
        );
        this.currentTurnId = null;
        this.rejectAllPending();
        this.flushNow();
        this.setState(turn.status === "failed" ? "error" : "idle");
        this.host.onTurnCompleted(this);
        return;
      }
      case "error": {
        if (params.willRetry === true) break;
        const error = isRecord(params.error) ? params.error : {};
        this.error = typeof error.message === "string" ? error.message : "Codex 执行出错";
        break;
      }
      default:
        return;
    }
    this.scheduleFlush();
  }

  // ───────────────────────── 审批 ─────────────────────────

  handleServerRequest(request: ServerRequest): boolean {
    const params = request.params;
    const itemId = String(params.itemId ?? "");
    const interactionId = randomUUID();
    let event: PermissionRequestEvent;
    let entry: PendingRequest;
    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const known = this.projector.itemInput(itemId);
        const command = typeof params.command === "string" ? params.command : String(known?.command ?? "");
        const input = { command: command.replace(/^\/bin\/(?:ba|z)?sh -l?c /, ""), ...(params.cwd ? { cwd: params.cwd } : {}) };
        entry = { request, kind: "command", itemId };
        event = this.permissionEvent(interactionId, itemId, "Bash", known ?? input, params.reason);
        break;
      }
      case "item/fileChange/requestApproval": {
        const input = this.projector.itemInput(itemId) ?? {};
        entry = { request, kind: "fileChange", itemId };
        event = this.permissionEvent(interactionId, itemId, "ApplyPatch", input, params.reason);
        break;
      }
      case "item/permissions/requestApproval": {
        entry = { request, kind: "permissions", itemId };
        event = {
          ...this.permissionEvent(interactionId, itemId, "RequestPermissions", {
            permissions: params.permissions,
            cwd: params.cwd,
          }, params.reason),
          canAllowForSession: true,
        };
        break;
      }
      case "item/tool/requestUserInput": {
        const rawQuestions = Array.isArray(params.questions) ? params.questions.filter(isRecord) : [];
        const questions = rawQuestions.map((q) => ({
          id: String(q.id ?? ""),
          question: String(q.question ?? ""),
          header: String(q.header ?? ""),
          options: Array.isArray(q.options)
            ? q.options.filter(isRecord).map((o) => ({ label: String(o.label ?? ""), description: String(o.description ?? "") }))
            : [],
          multiSelect: false,
        }));
        entry = { request, kind: "userInput", itemId, questions };
        event = {
          sessionKey: this.key,
          interactionId,
          toolUseId: itemId || interactionId,
          toolName: "AskUserQuestion",
          input: { questions },
          canAllowForSession: false,
        };
        break;
      }
      default:
        return false;
    }
    this.pending.set(interactionId, entry);
    this.responseMetrics.approval(interactionId, true);
    if (event.toolName !== "AskUserQuestion" && itemId) {
      this.projector.setToolPendingApproval(itemId, event.toolName, event.input, interactionId, Date.now());
      this.flushNow();
    }
    this.setState("awaitingApproval");
    this.host.emitPermission(event);
    return true;
  }

  private permissionEvent(
    interactionId: string,
    itemId: string,
    toolName: string,
    input: Record<string, unknown>,
    reason: unknown,
  ): PermissionRequestEvent {
    return {
      sessionKey: this.key,
      interactionId,
      toolUseId: itemId || interactionId,
      toolName,
      input,
      ...(typeof reason === "string" && reason ? { title: reason } : {}),
      canAllowForSession: true,
    };
  }

  ownsInteraction(interactionId: string): boolean {
    return this.pending.has(interactionId);
  }

  respondPermission(interactionId: string, decision: PermissionDecision) {
    const entry = this.pending.get(interactionId);
    if (!entry) return;
    this.pending.delete(interactionId);
    this.responseMetrics.approval(interactionId, false);
    const allowed = decision.decision === "allow" || decision.decision === "allowSession";
    const { client } = this.host;
    switch (entry.kind) {
      case "command":
      case "fileChange": {
        const value =
          decision.decision === "allow"
            ? "accept"
            : decision.decision === "allowSession"
              ? "acceptForSession"
              : decision.interrupt
                ? "cancel"
                : "decline";
        client.respond(entry.request.id, { decision: value });
        break;
      }
      case "permissions": {
        const requested = isRecord(entry.request.params.permissions) ? entry.request.params.permissions : {};
        client.respond(entry.request.id, {
          permissions: allowed ? requested : {},
          scope: decision.decision === "allowSession" ? "session" : "turn",
        });
        break;
      }
      case "userInput": {
        const answersByQuestion =
          decision.decision === "allow" && isRecord(decision.updatedInput?.answers)
            ? (decision.updatedInput.answers as Record<string, string>)
            : {};
        const answers: Record<string, { answers: string[] }> = {};
        for (const question of entry.questions ?? []) {
          const value = answersByQuestion[question.question];
          answers[question.id] = { answers: value ? value.split(", ").filter(Boolean) : [] };
        }
        client.respond(entry.request.id, { answers });
        break;
      }
    }
    if (entry.itemId && entry.kind !== "userInput") {
      this.projector.resolveToolApproval(entry.itemId, allowed);
      this.flushNow();
    }
    this.host.emitPermissionResolved({ sessionKey: this.key, interactionId });
    if (decision.decision === "deny" && decision.interrupt) void this.interrupt();
    if (this.pending.size === 0 && this.state === "awaitingApproval") this.setState("running");
  }

  /** app-server 自己撤回了请求（serverRequest/resolved），或者轮次结束时清理。 */
  resolveServerRequest(requestId: number | string) {
    for (const [interactionId, entry] of this.pending) {
      if (entry.request.id !== requestId) continue;
      this.pending.delete(interactionId);
      this.responseMetrics.approval(interactionId, false);
      this.host.emitPermissionResolved({ sessionKey: this.key, interactionId });
    }
  }

  private rejectAllPending() {
    for (const [interactionId, entry] of this.pending) {
      this.responseMetrics.approval(interactionId, false);
      this.host.client.respond(entry.request.id, entry.kind === "userInput" ? { answers: {} } : { decision: "cancel" });
      this.host.emitPermissionResolved({ sessionKey: this.key, interactionId });
    }
    this.pending.clear();
  }

  // ───────────────────────── 控制 ─────────────────────────

  async interrupt() {
    if (!this.isBusy || !this.threadId) return;
    this.projector.markInterrupted();
    if (!this.currentTurnId) return;
    try {
      await this.host.client.request("turn/interrupt", { threadId: this.threadId, turnId: this.currentTurnId });
    } catch {
      // turn 已结束时忽略
    }
  }

  async setPermissionMode(mode: PermissionMode) {
    this.permissionMode = mode; // 下一轮 turn/start 生效
    this.emitState();
  }

  async setModel(model: string) {
    this.model = model || undefined;
    this.emitState();
  }

  /** 释放本地绑定；同线程重绑定保留服务端订阅，避免异步 unsubscribe 取消新绑定的事件。 */
  close(unsubscribe = true) {
    this.closed = true;
    this.rejectAllPending();
    if (unsubscribe && this.threadId && this.host.client.running) {
      void this.host.client.request("thread/unsubscribe", { threadId: this.threadId }).catch(() => undefined);
    }
  }

  private fail(message: string) {
    this.error = message;
    this.projector.failTurn(`Codex 出错：${message}`, Date.now());
    this.currentTurnId = null;
    this.rejectAllPending();
    this.flushNow();
    this.setState("error");
  }

  private setState(state: ChatRunState) {
    if (this.state === state) return;
    if (state === "idle" || state === "error") this.responseMetrics.finish();
    if (state === "awaitingApproval") this.responseMetrics.endSegment();
    this.state = state;
    this.emitState();
  }

  emitState() {
    this.host.emitState({
      sessionKey: this.key,
      agent: "codex",
      ...(this.threadId ? { sessionId: this.threadId } : {}),
      projectPath: this.projectPath,
      state: this.state,
      ...(this.error ? { error: this.error } : {}),
      permissionMode: this.permissionMode,
      ...((this.model ?? this.reportedModel) ? { model: this.model ?? this.reportedModel } : {}),
      usage: { ...this.usage, outputSpeedBasis: "activeTurn", ...this.responseMetrics.snapshot(this.usage?.outputTokens) },
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
