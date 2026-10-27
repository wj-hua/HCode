// 一个正在进行的 Codex 会话（对应 app-server 的一个 thread）。
import { codexResearchTools } from "./researchTools.js";
import { HostedToolCalls } from "./hostedToolCalls.js";
import { assertInvocationThreadIdle } from './invocationRecovery.js';
import type { AgentSendParams } from '../types.js';
import { assertToolCatalog, readToolCatalog, sourceCatalogReason, type CodexToolSpec } from "./toolCatalog.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ChatRunState,
  CodexSpeed,
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
import { TurnLifecycle } from "../../sessions/turnLifecycle.js";
import type { TurnOutcome } from "../../../shared/collaboration.js";
import { codexResearchConfig, RESEARCH_PERMISSION_PROFILE, type ResearchRuntime, type HostedRuntime } from "../../sessions/researchRuntime.js";

const FLUSH_INTERVAL_MS = 16;
// 同一原生线程关闭再打开也不重复注入；应用重启后首轮重新同步。
const memoryHashes = new Map<string, string>();

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
  emitTurnOutcome?(event: TurnOutcome): void;
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
  speed: CodexSpeed | undefined;
  private speedOverridden = false;
  private speedInitialized = false;
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
  private readonly lifecycle: TurnLifecycle;
  private readonly assistantText = new Map<string, string>();
  private readonly hostedCalls: HostedToolCalls;
  private readonly projectReadTools: ResearchRuntime;
  private catalog: CodexToolSpec[] | undefined;
  private toolsCancelled = false;

  constructor(
    private readonly host: CodexSessionHost,
    options: { key: string; projectPath: string; threadId?: string; permissionMode: PermissionMode; model?: string; research?: ResearchRuntime },
  ) {
    this.key = options.key;
    this.projectPath = options.projectPath;
    this.threadId = options.threadId;
    this.permissionMode = options.permissionMode;
    this.model = options.model || undefined;
    this.lifecycle = new TurnLifecycle(this.key, "codex", (event) => this.host.emitTurnOutcome?.(event));
    this.research = options.research;
    this.projectReadTools = { root: this.projectPath };
    this.hostedCalls = new HostedToolCalls({ respond: (id, result) => this.host.client.respond(id, result), failure: (error) => this.fail(`宿主工具响应失败：${String(error)}`) });
  }

  get isBusy(): boolean {
    return this.state === "running" || this.state === "awaitingApproval";
  }
  private research: ResearchRuntime | undefined;
  private hosted: HostedRuntime | undefined;
  private requestedHosted: HostedRuntime | undefined;
  private memorySnapshot: string | undefined;
  private hostedAvailable = false;
  private ordinaryContinuation: string | undefined;
  private finalAnswer: string | undefined;

  seedHistory(turns: readonly CodexTurn[]) {
    for (const turn of turns) this.projector.consumeTurn(turn);
    this.projector.drain();
    this.host.emitRows(this.key, [{ op: "reset", rows: this.projector.snapshot() }]);
  }

  async send(text: string, images: readonly ImageInput[] = [], files: readonly FileInput[] = [], skill?: InvokedSkill, executionTurnId: string = randomUUID(), onNativeSession?: AgentSendParams['onNativeSession']) {
    if (this.closed) throw new Error("会话已关闭");
    this.lifecycle.begin(executionTurnId);
    this.currentTurnId = null;
    this.hostedCalls.cancel();
    this.toolsCancelled = false;
    this.assistantText.clear();
    this.finalAnswer = undefined;
    this.error = undefined;
    this.currentTurnId = null;
    this.responseMetrics.start();
    this.usage = this.usage ? {
      contextUsedTokens: this.usage.contextUsedTokens,
      contextWindowTokens: this.usage.contextWindowTokens,
      contextUsedPercent: this.usage.contextUsedPercent,
    } : undefined;
    this.projector.beginLocalTurn(text, Date.now(), images, files, executionTurnId);
    this.flushNow();
    this.setState("running");
    try {
      if (onNativeSession && this.threadId) {
        await this.host.client.ensureStarted();
        await assertInvocationThreadIdle(this.host.client, this.threadId, this.projectPath, this.attached);
      }
      await this.attach();
      if (onNativeSession) {
        if (!this.threadId) throw new Error('Codex 未返回原生会话 ID，不能开始委派任务');
        await assertInvocationThreadIdle(this.host.client, this.threadId, this.projectPath, true);
        await onNativeSession(this.threadId);
      }
      await this.injectContinuation();
      await this.injectMemory();
      if (/^\/compact\s*$/i.test(text)) {
        if (images.length || files.length) throw new Error("/compact 不能附带文件或图片");
        await this.host.client.request("thread/compact/start", { threadId: this.threadId });
        return;
      }
      const speedParams = await this.speedParams();
      const review = /^\/review(?:\s+([\s\S]*))?$/i.exec(text.trim());
      if (review) {
        if (images.length || files.length) throw new Error("/review 不能附带文件或图片");
        if ("serviceTier" in speedParams) {
          await this.host.client.request("thread/settings/update", { threadId: this.threadId, ...speedParams });
          this.speedOverridden = Boolean(this.speed);
          this.speedInitialized = true;
        }
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
        approvalPolicy: this.research ? "never" : policy.approvalPolicy,
        ...(this.research ? { permissions: RESEARCH_PERMISSION_PROFILE } : { sandboxPolicy: sandboxPolicyObject(policy.sandbox) }),
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
        ...speedParams,
        ...(this.research?.outputSchema ? { outputSchema: this.research.outputSchema } : {}),
        ...(this.ordinaryContinuation && !this.research ? { outputSchema: null } : {}),
        summary: "auto",
      });
      if ("serviceTier" in speedParams) {
        this.speedOverridden = Boolean(this.speed);
        this.speedInitialized = true;
      }
      this.currentTurnId = result.turn.id;
      this.lifecycle.bindNativeTurn(result.turn.id);
      this.bindHostedTools(result.turn.id);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** serviceTier 会保留到后续轮次；回到 CLI 默认时必须恢复配置，不能只省略字段。 */
  private async speedParams(): Promise<{ serviceTier?: string | null }> {
    if (this.speed === undefined) return {};
    if (this.speed) {
      return { serviceTier: this.speed };
    }
    if (this.speedInitialized && !this.speedOverridden) return {};
    const { config } = await this.host.client.request<{ config: { service_tier?: string | null } }>(
      "config/read", { cwd: this.projectPath, includeLayers: false },
    );
    return { serviceTier: config.service_tier ?? null };
  }

  /** 新会话 thread/start；历史会话 thread/resume（只取元数据，历史已由 seedHistory 填充）。 */
  private async attach() {
    await this.host.client.ensureStarted();
    if (this.attached && this.threadId) return;
    const policy = codexPolicy(this.permissionMode);
    const config = this.research || this.ordinaryContinuation
      ? (await this.host.client.request<{ config: Record<string, unknown> }>("config/read", { cwd: this.projectPath, includeLayers: false })).config
      : undefined;
    const researchConfig = this.research ? codexResearchConfig(this.research.root, config!, this.host.client.executableDirs) : undefined;
    const userInstructions = config ? z.string().nullish().parse(config.developer_instructions) : undefined;
    const common = {
      cwd: this.projectPath,
      approvalPolicy: this.research ? "never" : policy.approvalPolicy,
      ...(researchConfig ? { permissions: RESEARCH_PERMISSION_PROFILE, config: researchConfig } : { sandbox: policy.sandbox }),
      ...(this.ordinaryContinuation && !this.research ? { config: {}, developerInstructions: userInstructions ?? '' } : researchConfig ? { developerInstructions: userInstructions ?? '' } : {}),
      ...(this.model ? { model: this.model } : {}),
    };
    if (this.threadId) {
      if (this.research) {
        const catalog = this.catalog ?? await readToolCatalog(this.host.client, this.threadId);
        assertToolCatalog(catalog, this.research);
        this.catalog = catalog as CodexToolSpec[];
      }
      if (this.hosted && !this.research && !this.catalog) this.catalog = await readToolCatalog(this.host.client, this.threadId) as CodexToolSpec[];
      const result = await this.host.client.request<{ model?: string; activePermissionProfile?: { id: string } }>("thread/resume", {
        threadId: this.threadId,
        ...common,
        excludeTurns: true,
      });
      this.validateResearchProfile(result.activePermissionProfile);
      this.reportedModel = result.model;
    } else {
      // 普通会话的宿主工具依赖实验 API；CLI 版本未协商时照常建线程，只是不提供 call_agent。
      const tools = this.research ?? (this.hosted && this.host.client.experimentalApi ? this.hosted : undefined);
      const result = await this.host.client.request<{ thread: { id: string }; model?: string; activePermissionProfile?: { id: string } }>(
        "thread/start",
        { ...common, ...(tools ? { dynamicTools: codexResearchTools(tools) } : {}) },
      );
      this.validateResearchProfile(result.activePermissionProfile);
      this.threadId = result.thread.id;
      this.catalog = tools ? codexResearchTools(tools) : [];
      this.reportedModel = result.model;
      this.host.onThreadId(this);
    }
    this.validateHostedCatalog();
    this.attached = true;
    this.emitState();
  }

  private validateResearchProfile(profile?: { id: string }) {
    if (this.research && profile?.id !== RESEARCH_PERMISSION_PROFILE) throw new Error("Codex 未确认项目只读权限配置，已拒绝启动研究回合");
  }

  /** 0.162 原生接口明确追加模型可见开发者上下文；不换线程、不改用户气泡，也不依赖恢复时的提示词快照。 */
  private async injectContinuation() {
    const instructions = this.research
      ? '本回合是新的 HCode 宿主任务。此前普通续聊交接不改变本轮的工具、权限、范围或格式；遵守当前任务和实际运行时配置。'
      : [this.ordinaryContinuation, this.hosted?.instructions].filter(Boolean).join('\n');
    if (!instructions) return;
    await this.host.client.request('thread/inject_items', { threadId: this.threadId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: instructions }] }] });
  }

  configureMemory(snapshot?: string) {
    if (this.isBusy) throw new Error('Codex 活动回合不能更换记忆快照');
    this.memorySnapshot = snapshot;
  }

  private async injectMemory() {
    if (this.research || !this.memorySnapshot || !this.threadId) return;
    const hash = createHash('sha256').update(this.memorySnapshot).digest('hex');
    if (memoryHashes.get(this.threadId) === hash) return;
    await this.host.client.request('thread/inject_items', { threadId: this.threadId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: this.memorySnapshot }] }] });
    memoryHashes.set(this.threadId, hash);
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
      method === "item/reasoning/textDelta" || method === "item/plan/delta")) {
      if (this.responseMetrics.output(params.delta)) this.emitState();
    }
    if (metricsTurn && (method === "item/started" || method === "item/completed") && isRecord(params.item) &&
      typeof params.item.type === "string" && typeof params.item.id === "string") {
      if (this.responseMetrics.item(params.item.type, params.item.id, method === "item/started")) this.emitState();
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
        if (turn && typeof turn.id === "string") this.lifecycle.bindNativeTurn(turn.id);
        if (turn && typeof turn.id === "string") this.bindHostedTools(turn.id);
        break;
      }
      case "item/started":
        if (isRecord(params.item)) this.projector.itemStarted(params.item as CodexItem, now);
        break;
      case "item/completed":
        if (isRecord(params.item)) this.projector.itemCompleted(params.item as CodexItem, now);
        if (isRecord(params.item) && params.item.type === "agentMessage" && typeof params.item.text === "string") {
          this.assistantText.set(String(params.item.id), params.item.text);
          if (params.item.phase === "final_answer") this.finalAnswer = params.item.text;
        }
        break;
      case "item/agentMessage/delta":
        this.projector.appendText(String(params.itemId), String(params.delta ?? ""));
        this.assistantText.set(String(params.itemId), (this.assistantText.get(String(params.itemId)) ?? "") + String(params.delta ?? ""));
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
        if (this.currentTurnId && turn.id && this.currentTurnId !== turn.id) return;
        const known = turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted";
        const failure = turn.error?.message ?? this.error ?? (!known ? "Codex 未提供可信回合终态" : undefined);
        // 原生 completed 可能跟随不可重试错误；指标必须服从实际失败结果。
        if (metricsTurn) this.responseMetrics.finishTurn(failure ? "failed" : turn.status, turn.durationMs);
        this.projector.finishTurn(
          { status: known ? turn.status! : "failed", durationMs: turn.durationMs ?? null, error: failure ? { message: failure } : null },
          now,
        );
        this.currentTurnId = null;
        this.hostedCalls.cancel();
        this.rejectAllPending();
        this.flushNow();
        this.error = failure;
        this.setState(failure || turn.status === "failed" || !known ? "error" : "idle");
        this.host.onTurnCompleted(this);
        this.lifecycle.finish({
          outcome: failure ? "failed" : turn.status === "completed" ? "succeeded" : turn.status === "interrupted" ? "interrupted" : "failed",
          // 原生最终答复与进度说明分开；旧模型无 phase 时取最后一个完整消息，不猜 JSON 片段。
          text: this.finalAnswer ?? [...this.assistantText.values()].at(-1) ?? "", nativeTurnId: turn.id, nativeSessionId: this.threadId,
          ...(failure ? { error: failure } : {}), ...(this.usage ? { usage: this.usage } : {}),
        });
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

  /** 原生工具目录保持不变；普通回合绑定当前调用能力，拒绝旧研究阶段的委派闭包。 */
  private bindHostedTools(turnId: string) {
    if (!this.threadId || !this.isBusy || this.toolsCancelled) return;
    this.hostedCalls.begin(this.threadId, turnId, this.research ?? (this.hostedAvailable ? this.hosted! : this.projectReadTools));
  }

  handleServerRequest(request: ServerRequest): boolean {
    if (request.method === "item/tool/call") {
      this.hostedCalls.handle(request);
      return true;
    }
    if (this.research) {
      if (request.method === "item/permissions/requestApproval") this.host.client.respond(request.id, { permissions: {}, scope: "turn" });
      else if (request.method === "item/tool/requestUserInput") this.host.client.respond(request.id, { answers: {} });
      else if (request.method.endsWith("requestApproval")) this.host.client.respond(request.id, { decision: "decline" });
      else return false;
      return true;
    }
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
    this.lifecycle.requestCancellation();
    this.toolsCancelled = true;
    this.hostedCalls.cancel();
    this.projector.markInterrupted();
    if (!this.currentTurnId) return;
    try {
      await this.host.client.request("turn/interrupt", { threadId: this.threadId, turnId: this.currentTurnId });
    } catch (error) {
      if (this.research) throw error;
      // turn 已结束时忽略
    }
  }

  async setPermissionMode(mode: PermissionMode) {
    if (this.research && mode !== "read-only") throw new Error("协作研究期间不能扩大权限");
    this.permissionMode = mode; // 下一轮 turn/start 生效
    this.emitState();
  }

  /** 空闲回合边界更换宿主闭包；已有线程的原生工具目录必须仍然匹配。 */
  async configureResearch(runtime?: ResearchRuntime) {
    if (runtime === this.research) return;
    if (this.isBusy) throw new Error("Codex 活动回合不能切换协作工具");
    this.hostedCalls.cancel(); this.research = runtime; this.attached = false;
  }
  /** 交接在普通回合追加原生开发者上下文；更换时重新绑定原线程配置，不改写用户输入。 */
  async configureContinuation(instructions?: string) {
    if (instructions === this.ordinaryContinuation) return;
    if (this.isBusy) throw new Error('Codex 活动回合不能更换普通续聊交接');
    this.ordinaryContinuation = instructions;
    this.attached = false;
  }
  /** 普通回合只更换执行闭包；工具目录来自原生创建元数据，不替换历史线程。 */
  async configureHosted(runtime?: HostedRuntime) {
    if (this.isBusy) throw new Error('Codex 活动回合不能更换宿主工具');
    this.hostedCalls.cancel(); this.requestedHosted = runtime;
    this.validateHostedCatalog();
  }
  private validateHostedCatalog() {
    this.hosted = this.requestedHosted;
    if (this.hosted && this.catalog) {
      const registered = this.hosted.tools?.filter(tool => this.catalog!.some(spec => spec.name === `hcode_${tool.name}` && spec.namespace == null)) ?? [];
      const missing = this.hosted.tools?.filter(tool => !registered.includes(tool)) ?? [];
      const limits: string[] = [];
      if (missing.some(tool => tool.name.startsWith('memory_'))) limits.push('本线程未注册完整记忆工具，缺少的工具不能调用；本线程不能保存记忆，新建 Codex 会话后可用。仍可读取宿主提供的记忆快照，不得冒充已保存或删除。');
      const delegation = missing.filter(tool => !tool.name.startsWith('memory_'));
      if (delegation.length) limits.push(`本线程未注册 ${delegation.map(tool => tool.name).join('、')}，不能调用或冒充已派发。需要新增委派或并行工具请新建 Codex 会话；已有匹配工具可继续使用。`);
      if (missing.length && !this.host.client.experimentalApi) limits.push('当前 Codex CLI 版本尚未通过 HCode 宿主工具验证，安装已验证的版本后新建会话可用。');
      if (missing.length) this.hosted = { ...this.hosted, tools: registered, instructions: [registered.length ? this.hosted.instructions : undefined, ...limits].filter(Boolean).join('\n') };
    }
    this.hostedAvailable = Boolean(this.hosted?.tools?.length && this.catalog && this.hosted.tools.every(tool => this.catalog!.some(spec => spec.name === `hcode_${tool.name}`)));
    if (this.hostedAvailable) assertToolCatalog(this.catalog!, this.hosted!);
  }
  async collaborationSourceReason() {
    if (!this.threadId) return undefined;
    return sourceCatalogReason(this.catalog ?? await readToolCatalog(this.host.client, this.threadId));
  }

  async setModel(model: string) {
    this.model = model || undefined;
    this.emitState();
  }

  /** 释放本地绑定；同线程重绑定保留服务端订阅，避免异步 unsubscribe 取消新绑定的事件。 */
  close(unsubscribe = true) {
    this.closed = true;
    this.hostedCalls.cancel();
    this.rejectAllPending();
    this.lifecycle.finish({ outcome: "interrupted", text: "", error: "会话已关闭", nativeSessionId: this.threadId });
    if (unsubscribe && this.threadId && this.host.client.running) {
      void this.host.client.request("thread/unsubscribe", { threadId: this.threadId }).catch(() => undefined);
    }
  }

  private fail(message: string) {
    this.error = message;
    this.projector.failTurn(`Codex 出错：${message}`, Date.now());
    this.currentTurnId = null;
    this.hostedCalls.cancel();
    this.rejectAllPending();
    this.flushNow();
    this.setState("error");
    this.lifecycle.finish({ outcome: "failed", text: "", error: message, nativeSessionId: this.threadId });
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
