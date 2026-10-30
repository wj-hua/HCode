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
  ChatSteerResult,
  ChatPromptSuggestionEvent,
  ChatUsage,
  FileInput,
  ImageInput,
  PermissionDecision,
  PermissionMode,
  PermissionRequestEvent,
  PermissionResolvedEvent,
  RowOp,
  SlashCommandOption,
} from "../../../shared/types.js";
import { inputAttachments, type UserAttachment } from "../rowProjectorBase.js";
import { ClaudeResponseMetrics } from "./claudeResponseMetrics.js";
import { withFileReferences } from "../fileAttachments.js";
import { ClaudeRowProjector, type ClaudeRecord } from "./rowProjector.js";
import { TurnLifecycle } from "../../sessions/turnLifecycle.js";
import type { TurnOutcome } from "../../../shared/collaboration.js";
import { researchMcp, hostedMcp, RESEARCH_MCP_NAME, type ResearchRuntime, type HostedRuntime } from "../../sessions/researchRuntime.js";
import { ClaudePromptSuggestions } from './claudePromptSuggestions.js';
import { ClaudeBackgroundTasks } from './claudeBackgroundTasks.js';

const IDLE_CLOSE_MS = 10 * 60 * 1000;
const FLUSH_INTERVAL_MS = 16;
/** init 声明此能力时，interrupt 可连同排队消息一起撤回；插话依赖它保证“停止”不会被排队消息续跑。 */
const CANCEL_QUEUED_CAPABILITY = "interrupt_cancel_queued_v1";

export interface ClaudeSessionHost {
  emitTurnOutcome?(event: TurnOutcome): void;
  claudePath: string;
  env: Record<string, string>;
  emitRows(sessionKey: string, ops: RowOp[]): void;
  emitState(event: ChatStateEvent): void;
  emitPromptSuggestion?(event: ChatPromptSuggestionEvent): void;
  emitPermission(event: PermissionRequestEvent): void;
  emitPermissionResolved(event: PermissionResolvedEvent): void;
  onSessionId(sessionKey: string, sessionId: string, projectPath: string): void;
  /** 一轮结束或收到 rate_limit_event：额度可能变了。 */
  onQuotaChanged(): void;
  onCommandsChanged(sessionKey: string, commands: SlashCommandOption[]): void;
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

/** 文字 + 图片 → Anthropic 用户消息内容；空文本块会被 API 拒绝，所以只在有文字时带上。 */
function userContent(text: string, images: readonly ImageInput[], files: readonly FileInput[]): SDKUserMessage["message"]["content"] {
  const prompt = withFileReferences(text, files);
  if (!images.length) return prompt;
  return [
    ...images.map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mimeType as "image/png", data: image.data },
    })),
    ...(prompt.trim() ? [{ type: "text" as const, text: prompt }] : []),
  ];
}

/** 已写入流式输入、尚未被 CLI 并入回合的插话；投递或退回时结算发起方的等待。 */
interface PendingSteer {
  text: string;
  attachments: UserAttachment[];
  resolve(result: ChatSteerResult): void;
}

/**
 * SDK 运行时的 interrupt 接受 cancelQueued，但 0.3.280 的 Query 类型未声明该参数。
 * 只在 init 声明 CANCEL_QUEUED_CAPABILITY 后调用；回执 cancelled 列出被撤回的消息 uuid。
 */
type CancelQueuedInterrupt = (options: { cancelQueued: true }) => Promise<{ cancelled?: string[] } | undefined>;

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
  private usage: ChatUsage | undefined;
  private readonly responseMetrics = new ClaudeResponseMetrics();
  private usageVersion = 0;
  private readonly lifecycle: TurnLifecycle;
  private research: ResearchRuntime | undefined;
  private hosted: HostedRuntime | undefined;
  private memorySnapshot: string | undefined;
  private ordinaryContinuation: string | undefined;
  private pumpPromise: Promise<void> | null = null;
  private readonly promptSuggestions: ClaudePromptSuggestions;
  private readonly backgroundTasks = new ClaudeBackgroundTasks();
  private readonly steers = new Map<string, PendingSteer>();
  private canCancelQueued = false;
  /** 回合结束时仍有未投递插话：CLI 会立即用它们开下一轮，期间保持运行态。 */
  private queuedTurnPending = false;

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
    this.lifecycle = new TurnLifecycle(this.key, "claude", (event) => this.host.emitTurnOutcome?.(event));
    this.promptSuggestions = new ClaudePromptSuggestions({ sessionKey: this.key, projectPath: this.projectPath }, event => this.host.emitPromptSuggestion?.(event));
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

  get hasBackgroundTasks(): boolean {
    return this.backgroundTasks.count > 0;
  }

  /** 只在空闲回合边界更换工具，停止旧 query 后保留原生身份与投影历史。 */
  async configureResearch(runtime: ResearchRuntime | undefined) {
    if (this.research === runtime) return;
    if (this.isBusy) throw new Error("会话运行中，不能更换协作工具");
    await this.releaseQuery();
    this.research = runtime;
  }

  /** 仅在空闲边界更换交接，按原生身份重建 query，避免旧研究限制和旧系统追加继续生效。 */
  async configureContinuation(instructions?: string) {
    if (instructions === this.ordinaryContinuation) return;
    if (this.isBusy) throw new Error('会话运行中，不能更换普通续聊交接');
    await this.releaseQuery();
    this.ordinaryContinuation = instructions;
  }

  async configureMemory(snapshot?: string) {
    if (snapshot === this.memorySnapshot) return;
    if (this.isBusy) throw new Error('活动回合不能更换记忆快照');
    await this.releaseQuery();
    this.memorySnapshot = snapshot;
  }

  /** 在原生身份不变的空闲边界追加普通会话工具，不套用研究模式或替换用户输入。 */
  async configureHosted(runtime?: HostedRuntime) {
    if (runtime === this.hosted) return;
    if (this.isBusy) throw new Error('活动回合不能切换宿主工具');
    await this.releaseQuery();
    this.hosted = runtime;
  }

  private async releaseQuery() {
    this.promptSuggestions.clear();
    this.clearIdleTimer(); this.input?.end(); this.activeQuery?.close();
    await this.pumpPromise;
  }

  async listCommands(): Promise<SlashCommandOption[] | null> {
    if (!this.activeQuery) return null;
    const commands = await this.activeQuery.supportedCommands();
    return commands.map(({ name, description, argumentHint, aliases }) => ({
      name, description, argumentHint, ...(aliases?.length ? { aliases } : {}),
    }));
  }

  send(text: string, images: readonly ImageInput[] = [], files: readonly FileInput[] = [], executionTurnId: string = randomUUID()) {
    if (this.closed) throw new Error("会话已关闭");
    this.lifecycle.begin(executionTurnId);
    this.promptSuggestions.begin(executionTurnId, this.sessionId, !this.research && this.permissionMode !== 'plan', !this.activeQuery);
    this.clearIdleTimer();
    this.error = undefined;
    this.responseMetrics.start();
    this.usageVersion++;
    this.usage = this.usage ? {
      contextUsedTokens: this.usage.contextUsedTokens,
      contextWindowTokens: this.usage.contextWindowTokens,
      contextUsedPercent: this.usage.contextUsedPercent,
    } : undefined;
    this.projector.beginUserTurn(text, Date.now(), executionTurnId, inputAttachments(images, files));
    this.flushNow();
    if (!this.activeQuery) this.start();
    this.input!.push({
      type: "user",
      message: { role: "user", content: userContent(text, images, files) },
      parent_tool_use_id: null,
      uuid: executionTurnId,
    } as SDKUserMessage);
    this.setState("running");
  }

  /**
   * 回合进行中插话：以 priority 'next' 写入流式输入，CLI 在下一个工具间隙把它并入当前回合。
   * 以 replay 回显作为投递确认后才结算；回合先结束时 CLI 会把它作为下一轮执行，同样算已投递。
   * 停止时连同未投递的插话一起撤回并退回给发起方，所以要求 CLI 支持撤回排队消息。
   */
  steer(text: string, images: readonly ImageInput[] = [], files: readonly FileInput[] = []): Promise<ChatSteerResult> {
    const blocked = this.steerBlocker();
    if (blocked) return Promise.resolve({ delivered: false, reason: blocked });
    const uuid = randomUUID();
    return new Promise((resolve) => {
      this.steers.set(uuid, { text, attachments: inputAttachments(images, files), resolve });
      this.input!.push({
        type: "user",
        message: { role: "user", content: userContent(text, images, files) },
        parent_tool_use_id: null,
        uuid,
        priority: "next",
      } as SDKUserMessage);
    });
  }

  private steerBlocker(): string | undefined {
    if (this.closed || !this.isBusy || !this.input) return "当前没有进行中的回合";
    if (this.research) return "协作研究回合不接受插话";
    if (!this.canCancelQueued) return "当前 Claude CLI 版本不支持停止时撤回插话";
    return undefined;
  }

  /** replay 回显即投递确认：回合仍在进行则并入当前轮，否则 CLI 已用它开始新一轮。 */
  private deliverSteer(uuid: string): boolean {
    const steer = this.steers.get(uuid);
    if (!steer) return false;
    this.steers.delete(uuid);
    const at = Date.now();
    if (this.projector.hasOpenTurn) this.projector.appendGuidedInput(steer.text, at, uuid, steer.attachments);
    else this.projector.beginUserTurn(steer.text, at, uuid, steer.attachments);
    this.flushNow();
    steer.resolve({ delivered: true });
    return true;
  }

  private returnSteer(uuid: string, reason: string) {
    const steer = this.steers.get(uuid);
    if (!steer) return;
    this.steers.delete(uuid);
    steer.resolve({ delivered: false, reason });
  }

  private returnAllSteers(reason: string) {
    for (const uuid of [...this.steers.keys()]) this.returnSteer(uuid, reason);
    this.queuedTurnPending = false;
  }

  private start() {
    const input = new InputQueue<SDKUserMessage>();
    this.input = input;
    // 后台任务快照按进程计；新进程启动时不会补发，必须先清零
    this.backgroundTasks.reset();
    this.canCancelQueued = false;
    const permissionMode = this.permissionMode;
    const instructions = [this.ordinaryContinuation, this.hosted?.instructions, this.memorySnapshot].filter(Boolean).join('\n');
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
        canUseTool: this.research ? undefined : this.canUseTool,
        includePartialMessages: true,
        // 回显写入流式输入的用户消息：插话以回显确认投递，并判断它并入了当前轮还是开启了新一轮
        extraArgs: { "replay-user-messages": null },
        promptSuggestions: !this.research,
        thinking: { type: "adaptive", display: "summarized" },
        settingSources: ["user", "project", "local"],
        // SDK 默认冻结第一轮系统提示；研究与交接必须按本次运行配置刷新，不能复用旧快照。
        systemPrompt: { type: "preset", preset: "claude_code", ...(this.research || instructions ? { snapshot: false } : {}), ...(!this.research && instructions ? { append: instructions } : {}) },
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort as EffortLevel } : {}),
        ...(this.research ? {
          tools: [], settingSources: [], settings: { disableAllHooks: true }, strictMcpConfig: true,
          mcpServers: { [RESEARCH_MCP_NAME]: researchMcp(this.research) },
          allowedTools: ["mcp__hcode__read_file", "mcp__hcode__list_files", ...(this.research.tools ?? []).map((definition) => `mcp__hcode__${definition.name}`)],
          ...(this.research.outputSchema ? { outputFormat: { type: "json_schema" as const, schema: this.research.outputSchema } } : {}),
        } : this.hosted ? { mcpServers: { [RESEARCH_MCP_NAME]: hostedMcp(this.hosted.tools ?? []) }, allowedTools: (this.hosted.tools ?? []).map(definition => `mcp__hcode__${definition.name}`) } : {}),
        stderr: (data: string) => {
          if (process.env.HCODE_DEBUG) process.stderr.write(`[claude] ${data}`);
        },
      },
    });
    this.pumpPromise = this.pump(this.activeQuery);
  }

  private async pump(activeQuery: Query) {
    try {
      for await (const message of activeQuery) {
        if (message.type === 'prompt_suggestion') {
          if (!this.closed && this.activeQuery === activeQuery) this.promptSuggestions.receive(message.suggestion, message.session_id);
          continue;
        }
        this.handleMessage(message);
      }
    } catch (error) {
      if (!this.closed) {
        this.promptSuggestions.clear();
        const message = error instanceof Error ? error.message : String(error);
        this.projector.failTurn(`Claude 进程异常：${message}`, Date.now());
        this.error = message;
      }
    } finally {
      // 旧 query 的异步退出不能结束后续 query 的回合或清空其审批状态。
      if (this.activeQuery && this.activeQuery !== activeQuery) return;
      if (this.activeQuery === activeQuery) {
        this.activeQuery = null;
        this.input = null;
      }
      this.rejectAllPending("会话已结束");
      this.returnAllSteers("Claude 进程已结束，插话未送达");
      if (!this.closed && this.backgroundTasks.endProcess()) this.emitState();
      if (this.projector.hasOpenTurn) this.projector.closeTurn(Date.now(), this.error ? "failed" : undefined);
      this.flushNow();
      if (!this.closed) this.setState(this.error ? "error" : "idle");
      this.lifecycle.finish({ outcome: this.error ? "failed" : "interrupted", text: "", error: this.error ?? "Claude 未返回可信回合结果即结束", nativeSessionId: this.sessionId });
    }
  }

  private handleMessage(message: SDKMessage) {
    if (message.type === "user" && "isReplay" in message && message.isReplay && message.uuid && this.deliverSteer(message.uuid)) return;
    if (message.type === "stream_event" && this.responseMetrics.consumeStream(message)) this.emitState();
    if (message.type === "system" && message.subtype === "commands_changed") {
      this.host.onCommandsChanged(this.key, message.commands.map(({ name, description, argumentHint, aliases }) => ({
        name, description, argumentHint, ...(aliases?.length ? { aliases } : {}),
      })));
    }
    if (this.backgroundTasks.consume(message)) {
      this.emitState();
      if (!this.isBusy) this.scheduleIdleClose();
    }
    if (message.type === "system" && message.subtype === "init") {
      this.canCancelQueued = message.capabilities?.includes(CANCEL_QUEUED_CAPABILITY) === true;
      // 后台任务结束或执行未投递的插话时，CLI 会自行开启新一轮回复，这一轮不经过 send()
      if (!this.isBusy || this.queuedTurnPending) this.beginNativeTurn();
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
      this.promptSuggestions.complete(message.subtype === 'success' && !message.is_error, message.session_id);
      const version = this.usageVersion;
      const input = message.usage.input_tokens + message.usage.cache_read_input_tokens + message.usage.cache_creation_input_tokens;
      this.usage = {
        inputTokens: input,
        outputTokens: message.usage.output_tokens,
      };
      const activeQuery = this.activeQuery;
      if (activeQuery) {
        void activeQuery.getContextUsage({ detail: "summary" }).then((context) => {
          if (this.closed || version !== this.usageVersion || !this.usage) return;
          if (Number.isFinite(context.totalTokens) && context.totalTokens >= 0 && context.maxTokens > 0) {
            this.usage = {
              ...this.usage,
              contextUsedTokens: context.totalTokens,
              contextWindowTokens: context.maxTokens,
              contextUsedPercent: context.totalTokens / context.maxTokens * 100,
            };
            this.emitState();
          }
        }).catch(() => undefined);
      }
      this.host.onQuotaChanged();
      this.flushNow();
      if (message.subtype !== "success" || message.is_error) this.error = message.subtype === "success" ? message.result : message.errors.join("\n");
      // 未投递的插话会被 CLI 立即作为下一轮执行；保持运行态，避免渲染进程误判空闲后重复发送
      this.queuedTurnPending = this.steers.size > 0;
      if (this.queuedTurnPending) this.responseMetrics.finish();
      else if (this.pending.size === 0) this.setState(this.error ? "error" : "idle");
      else this.emitState();
      this.scheduleIdleClose();
      this.lifecycle.finish({
        outcome: message.subtype === "success" && !message.is_error ? "succeeded" : "failed",
        text: message.subtype === "success" ? (message.structured_output !== undefined ? JSON.stringify(message.structured_output) : message.result) : "",
        ...(message.subtype !== "success" ? { error: message.errors.join("\n") } : message.is_error ? { error: message.result } : {}),
        nativeSessionId: message.session_id,
        usage: this.usage,
      });
      return;
    }
    this.scheduleFlush();
  }

  private beginNativeTurn() {
    this.queuedTurnPending = false;
    this.promptSuggestions.clear();
    this.clearIdleTimer();
    this.error = undefined;
    this.responseMetrics.start();
    this.usageVersion++;
    this.setState("running");
  }

  private readonly canUseTool: CanUseTool = (toolName, input, options) => {
    if (this.research) return Promise.resolve({ behavior: "deny", message: `研究会话禁止非白名单工具：${toolName}` });
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

  async stopBackgroundTask(taskId: string) {
    if (!this.activeQuery || !this.backgroundTasks.canStop(taskId)) throw new Error('后台任务不存在或已结束');
    await this.activeQuery.stopTask(taskId);
  }

  async interrupt() {
    if (!this.isBusy) return;
    this.promptSuggestions.clear();
    this.lifecycle.requestCancellation();
    this.projector.markInterrupted();
    this.rejectAllPending("用户已停止");
    try {
      if (this.activeQuery) await this.interruptQuery(this.activeQuery);
    } catch (error) {
      if (this.research) throw error;
      // 进程已退出时忽略
    }
  }

  /** 有未投递插话时连同排队消息一起撤回；否则 CLI 会在中断后把它们作为新一轮继续执行。 */
  private async interruptQuery(activeQuery: Query) {
    if (this.steers.size === 0) {
      await activeQuery.interrupt();
      return;
    }
    const interrupt = activeQuery.interrupt as unknown as CancelQueuedInterrupt;
    const receipt = await interrupt.call(activeQuery, { cancelQueued: true });
    for (const uuid of receipt?.cancelled ?? []) this.returnSteer(uuid, "已停止，插话未送达");
    // 停在“上一轮已结束、插话轮尚未开始”的间隙：没有回合会再结束，需要在这里落回空闲
    if (this.queuedTurnPending && this.steers.size === 0) {
      this.queuedTurnPending = false;
      this.setState(this.error ? "error" : "idle");
    }
  }

  async setPermissionMode(mode: PermissionMode) {
    if (this.research && mode !== "default" && mode !== "plan") throw new Error("协作研究期间不能扩大权限");
    this.permissionMode = mode;
    if (mode === 'plan') this.promptSuggestions.clear();
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
    this.promptSuggestions.clear();
    this.closed = true;
    if (this.backgroundTasks.endProcess()) this.emitState();
    this.clearIdleTimer();
    this.rejectAllPending("会话已关闭");
    this.returnAllSteers("会话已关闭，插话未送达");
    this.input?.end();
    this.activeQuery?.close();
    this.activeQuery = null;
    this.input = null;
    this.lifecycle.finish({ outcome: "interrupted", text: "", error: "会话已关闭", nativeSessionId: this.sessionId });
  }

  // ───────────────────────── 内部工具 ─────────────────────────

  private scheduleIdleClose() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      // 关闭进程会连带结束后台任务；任务结束时会重新计时
      if (this.isBusy || this.hasBackgroundTasks) return;
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
    if (state === "idle" || state === "error") this.responseMetrics.finish();
    if (state === "awaitingApproval") this.responseMetrics.endSegment();
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
      ...(this.backgroundTasks.count ? { backgroundTasks: this.backgroundTasks.count } : {}),
      backgroundTaskDetails: this.backgroundTasks.snapshot(),
      ...(this.error ? { error: this.error } : {}),
      permissionMode: this.permissionMode,
      ...(this.model ? { model: this.model } : {}),
      usage: { ...this.usage, outputSpeedBasis: "response", ...this.responseMetrics.snapshot(this.usage?.outputTokens) },
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
