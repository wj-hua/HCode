import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatRunState, ChatUsage, PermissionDecision, PermissionMode } from "../../../shared/types.js";
import { TurnLifecycle } from "../../sessions/turnLifecycle.js";
import { withFileReferences } from "../fileAttachments.js";
import type { ServerRequest } from "../codex/appServerClient.js";
import { ClineResponseMetrics } from "./clineResponseMetrics.js";
import { inputAttachments, isRecord, type JsonRecord } from "../rowProjectorBase.js";
import type { AgentEvents, AgentSendParams } from "../types.js";
import { ClineClient, type ClineLaunch } from "./clineClient.js";
import { ClineRowProjector } from "./clineProjector.js";

interface PendingApproval { request: ServerRequest; toolId: string; options: JsonRecord[] }
const PLAN_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "read_files", "search_codebase", "fetch_web_content", "web_search"]);

export class ClineSession {
  readonly key: string;
  readonly projectPath: string;
  sessionId: string | undefined;
  permissionMode: PermissionMode;
  model: string;
  private state: ChatRunState = "idle";
  private error: string | undefined;
  private client: ClineClient | undefined;
  private projector = new ClineRowProjector();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly lifecycle: TurnLifecycle;
  private readonly metrics = new ClineResponseMetrics();
  private usage: ChatUsage = {};
  private cancelled = false;
  private disposed = false;
  private cancelTimer: ReturnType<typeof setTimeout> | undefined;

  get running() { return this.state === "running" || this.state === "awaitingApproval"; }

  constructor(
    params: AgentSendParams,
    private readonly events: AgentEvents,
    private readonly launch: (cwd: string, effort?: string, model?: string) => Promise<ClineLaunch>,
    private readonly attachmentsRoot: string,
    private readonly settled: () => void,
    private readonly readHistory?: (id: string) => Promise<ClineRowProjector>,
  ) {
    this.key = params.sessionKey;
    this.projectPath = params.projectPath;
    this.sessionId = params.resumeSessionId;
    this.permissionMode = params.permissionMode;
    this.model = params.model ?? "";
    this.lifecycle = new TurnLifecycle(this.key, "cline", (event) => events.turnOutcome?.(event));
  }

  private emitState() {
    this.events.state({ sessionKey: this.key, agent: "cline", projectPath: this.projectPath,
      sessionId: this.sessionId, state: this.state, permissionMode: this.permissionMode,
      model: this.model, error: this.error, usage: this.currentUsage() });
  }
  private currentUsage(): ChatUsage {
    const metrics = this.metrics.snapshot(this.cancelled || this.state === "error" ? undefined : this.usage.outputTokens);
    return { ...this.usage, ...metrics };
  }
  private flush() {
    const ops = this.projector.drain();
    if (ops.length) this.events.rows(this.key, ops);
  }

  async send(params: AgentSendParams) {
    if (this.state === "running" || this.state === "awaitingApproval") throw new Error("Cline 会话仍在运行");
    if (this.disposed) throw new Error("Cline 会话已关闭");
    this.lifecycle.begin(params.executionTurnId ?? randomUUID());
    this.cancelled = false;
    this.error = undefined;
    this.permissionMode = params.permissionMode;
    this.model = params.model ?? "";
    this.metrics.start();
    this.usage = {};
    const startedAt = Date.now();
    this.state = "running";
    this.projector.beginUserTurn(params.text, startedAt, undefined, inputAttachments(params.images, params.files));
    this.flush();
    this.emitState();
    let failed: string | undefined;
    let stopReason: string | undefined;
    try {
      const launch = await this.launch(this.projectPath, params.effort, params.model);
      if (this.cancelled) return;
      const client = new ClineClient(launch);
      this.client = client;
      let replaying = Boolean(this.sessionId);
      const localHistory = this.sessionId ? await this.readHistory?.(this.sessionId).catch(() => undefined) : undefined;
      const replay = localHistory ?? new ClineRowProjector();
      client.on("notification", (method: string, value: JsonRecord) => {
        if (method !== "session/update" || value.sessionId !== this.sessionId || !isRecord(value.update)) return;
        if (replaying) { if (!localHistory) replay.update(value.update); return; }
        this.metrics.update(value.update);
        this.projector.update(value.update);
        this.flush();
        if ((value.update.sessionUpdate === "agent_message_chunk" || value.update.sessionUpdate === "agent_thought_chunk") && isRecord(value.update.content) && this.metrics.output(value.update.content.text)) this.emitState();
      });
      client.on("request", (request: ServerRequest) => this.requestPermission(request));
      const init = await client.initialize();
      if (this.cancelled) return;
      if (this.sessionId) {
        if (!isRecord(init.agentCapabilities) || init.agentCapabilities.loadSession !== true) throw new Error("此 Cline 版本不支持历史续聊，请更新 CLI");
        await client.request("session/load", { sessionId: this.sessionId, cwd: this.projectPath, mcpServers: [] });
        if (this.cancelled) return;
        replay.closeTurn(Date.now());
        replay.drain();
        this.projector = replay;
        this.events.rows(this.key, [{ op: "reset", rows: replay.snapshot() }]);
      } else {
        const result = await client.request<JsonRecord>("session/new", { cwd: this.projectPath, mcpServers: [] });
        if (typeof result.sessionId !== "string" || !result.sessionId) throw new Error("Cline 未返回会话 ID");
        this.sessionId = result.sessionId;
      }
      replaying = false;
      if (this.cancelled) return;
      await this.configureMode();
      const modelId = launch.modelId ?? params.model;
      if (modelId) await client.request("session/set_model", { sessionId: this.sessionId, modelId });
      const files = [...(params.files ?? [])];
      // Cline 3.0.70 ACP 只提取 text 块；保存图片并让原生 read_files 工具读取。
      for (const image of params.images ?? []) {
        const dir = join(this.attachmentsRoot, this.sessionId);
        await mkdir(dir, { recursive: true });
        const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[image.mimeType] ?? "png";
        const path = join(dir, `${randomUUID()}.${extension}`);
        const data = Buffer.from(image.data, "base64");
        await writeFile(path, data);
        files.push({ path, name: image.name ?? "图片", mimeType: image.mimeType, size: data.length });
      }
      if (this.cancelled) return;
      if (!this.projector.hasOpenTurn) this.projector.beginUserTurn(params.text, Date.now(), undefined, inputAttachments(params.images, params.files));
      this.flush();
      this.emitState();
      this.metrics.beginTurn(randomUUID());
      const result = await client.request<JsonRecord>("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: withFileReferences(params.text, files) }] }, 0);
      this.metrics.finishTurn(result.stopReason === "end_turn" && !this.cancelled ? "completed" : "cancelled");
      if (typeof result.stopReason !== "string") throw new Error("Cline 未返回回合结束原因");
      stopReason = result.stopReason;
      if (!["end_turn", "cancelled"].includes(stopReason)) throw new Error(`Cline 回合未完成：${stopReason}`);
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.cancelTimer) clearTimeout(this.cancelTimer);
      this.cancelTimer = undefined;
      this.clearApprovals();
      const client = this.client;
      client?.dispose();
      if (client) await client.closed;
      this.client = undefined;
      let cancelled = this.cancelled || stopReason === "cancelled";
      if (!cancelled && this.sessionId && this.readHistory) {
        try {
          const persisted = await this.readHistory(this.sessionId);
          const lastInput = persisted.snapshot().findLast((row) => row.kind === "userInput");
          // 只恢复本次发送之后的记录，不能把上一轮的同名输入当成本轮回复。
          if (!this.cancelled && lastInput?.kind === "userInput" && lastInput.createdAt >= startedAt && lastInput.text.trim() === params.text.trim()) {
            this.usage = persisted.lastTurnUsage;
            const persistedError = persisted.lastTurnError;
            if (persistedError || !this.hasReply()) {
              this.projector = persisted;
              this.events.rows(this.key, [{ op: "reset", rows: persisted.snapshot() }]);
            }
            failed = persistedError ?? failed;
          }
        } catch { /* 文件不可用时保留已经收到的实时消息与错误。 */ }
      }
      cancelled ||= this.cancelled;
      if (!cancelled && !failed && stopReason === "end_turn" && !this.hasReply()) failed = "Cline 已结束本轮，但没有返回回复。请重试或检查 CLI 与提供商配置。";
      this.cancelled = cancelled;
      this.metrics.finish();
      if (cancelled) { this.projector.markInterrupted(); this.projector.closeTurn(Date.now()); }
      else if (failed && this.projector.lastTurnError !== failed) this.projector.failTurn(failed, Date.now());
      else this.projector.closeTurn(Date.now());
      this.flush();
      this.state = failed && !cancelled ? "error" : "idle";
      this.error = cancelled ? undefined : failed;
      const rows = this.projector.snapshot();
      const lastTurnId = rows.findLast((row) => row.kind === "turnHeader")?.turnId;
      const text = rows.filter((row) => row.kind === "assistantText" && row.turnId === lastTurnId).map((row) => row.kind === "assistantText" ? row.text : "").join("\n");
      this.lifecycle.finish({ outcome: cancelled ? "cancelled" : failed ? "failed" : "succeeded", nativeSessionId: this.sessionId, text, usage: this.currentUsage(), ...(failed && !cancelled ? { error: failed } : {}) });
      this.emitState();
      this.settled();
    }
  }

  private hasReply(): boolean {
    const rows = this.projector.snapshot();
    const turnId = rows.findLast((row) => row.kind === "turnHeader")?.turnId;
    return rows.some((row) => row.turnId === turnId && row.kind === "assistantText" && row.state !== "failed" && Boolean(row.text.trim()));
  }

  private requestPermission(request: ServerRequest) {
    const client = this.client;
    if (!client) return;
    if (request.method !== "session/request_permission") { client.unsupported(request.id); return; }
    const tool = isRecord(request.params.toolCall) ? request.params.toolCall : {};
    if (request.params.sessionId !== this.sessionId || this.cancelled || typeof tool.toolCallId !== "string") {
      client.respond(request.id, { outcome: { outcome: "cancelled" } }); return;
    }
    const options = Array.isArray(request.params.options) ? request.params.options.filter(isRecord) : [];
    const title = typeof tool.title === "string" ? tool.title : "Cline 工具";
    const name = title.split(":")[0]!;
    const input = isRecord(tool.rawInput) ? tool.rawInput : {};
    if (this.permissionMode === "bypass" || this.permissionMode === "plan") {
      const allow = this.permissionMode === "bypass" || PLAN_TOOLS.has(name);
      const option = options.find((entry) => entry.kind === (allow ? "allow_once" : "reject_once"));
      client.respond(request.id, { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } });
      return;
    }
    const id = randomUUID();
    this.approvals.set(id, { request, toolId: tool.toolCallId, options });
    this.metrics.approval(id, true);
    this.projector.setToolPendingApproval(tool.toolCallId, name, input, id, Date.now());
    this.flush();
    this.state = "awaitingApproval";
    this.emitState();
    // Cline 的 allow_always 目前只批准本次，没有会话记忆，不能展示“总是允许”。
    this.events.permission({ sessionKey: this.key, interactionId: id, toolUseId: tool.toolCallId, toolName: name, input, title, canAllowForSession: false });
  }

  respondPermission(id: string, decision: PermissionDecision): boolean {
    const pending = this.approvals.get(id);
    if (!pending || !this.client) return false;
    const allowed = decision.decision !== "deny";
    const option = pending.options.find((entry) => entry.kind === (allowed ? "allow_once" : "reject_once"));
    this.client.respond(pending.request.id, { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } });
    this.approvals.delete(id);
    this.metrics.approval(id, false);
    this.projector.resolveToolApproval(pending.toolId, allowed && Boolean(option));
    this.flush();
    this.events.permissionResolved({ sessionKey: this.key, interactionId: id });
    this.state = this.approvals.size ? "awaitingApproval" : "running";
    this.emitState();
    if (decision.decision === "deny" && decision.interrupt) void this.interrupt();
    return true;
  }

  private clearApprovals() {
    for (const [id, pending] of this.approvals) {
      try { this.client?.respond(pending.request.id, { outcome: { outcome: "cancelled" } }); } catch { /* 进程已退出 */ }
      this.projector.resolveToolApproval(pending.toolId, false);
      this.events.permissionResolved({ sessionKey: this.key, interactionId: id });
    }
    this.approvals.clear();
  }

  async interrupt() {
    if (this.state !== "running" && this.state !== "awaitingApproval") return;
    this.cancelled = true;
    this.lifecycle.requestCancellation();
    this.clearApprovals();
    if (this.client && this.sessionId) {
      try { this.client.notify("session/cancel", { sessionId: this.sessionId }); } catch { /* 进程已退出 */ }
    }
    if (this.client && !this.cancelTimer) this.cancelTimer = setTimeout(() => this.client?.dispose(), 3000);
  }

  private async configureMode() {
    if (!this.client || !this.sessionId) return;
    await this.client.request("session/set_mode", { sessionId: this.sessionId, modeId: this.permissionMode === "plan" ? "plan" : "act" });
    // 保持 CLI 审批开启，由宿主按模式决定，计划模式也覆盖旧会话的原生权限。
  }
  async setPermissionMode(mode: PermissionMode) {
    if (!["default", "plan", "bypass"].includes(mode)) throw new Error("Cline 不支持此权限模式");
    this.permissionMode = mode;
    await this.configureMode();
    this.emitState();
  }
  async setModel(model: string) {
    // 每轮按发送时的模型启动进程；运行中选择的新模型从下一轮生效。
    this.model = model;
    this.emitState();
  }
  dispose() {
    this.disposed = true;
    void this.interrupt();
    this.client?.dispose();
  }
}
