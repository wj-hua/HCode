// Claude Code 接入：历史 + 实时会话 + 审批的统一入口。
import { join } from "node:path";
import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AGENTS } from "../../../shared/agents.js";
import type {
  AgentQuota,
  AgentStatus,
  ChatSendParams,
  ForkParams,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  SessionLoadResult,
  SessionSummary,
  SlashCommandOption,
} from "../../../shared/types.js";
import { probeCli } from "../../util/locateCli.js";
import { claudeQuota, quotaError } from "../quota.js";
import type { AgentEvents, AgentProvider } from "../types.js";
import { ClaudeHistory } from "./claudeHistory.js";
import { ClaudeSession } from "./claudeSession.js";

const QUOTA_TIMEOUT_MS = 30_000;
const COMMANDS_TIMEOUT_MS = 15_000;

/** 不产出任何消息的输入流：只用来拉起 claude 进程发控制请求，不会发起对话。 */
async function* idleInput(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

export class ClaudeAgent implements AgentProvider {
  readonly kind = "claude" as const;
  private readonly history: ClaudeHistory;
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly interactionOwner = new Map<string, string>();
  private status: AgentStatus | null = null;
  private models: ModelOption[] | null = null;

  constructor(
    private readonly events: AgentEvents,
    private readonly getEnv: () => Record<string, string>,
    private readonly getPathOverride: () => string,
  ) {
    this.history = new ClaudeHistory((paths) => events.indexChanged(paths));
  }

  async getStatus(refresh = false): Promise<AgentStatus> {
    if (!this.status || refresh) {
      this.status = await probeCli("claude", "claude", this.getEnv(), this.getPathOverride(), [
        join(homedir(), ".claude/local/claude"),
      ]);
    }
    return this.status;
  }

  /** 从 SDK 拉取当前账号可用的完整模型列表（含具体版本）；失败时退回内置别名。 */
  async listModels(): Promise<ModelOption[]> {
    if (this.models) return this.models;
    const status = await this.getStatus();
    if (!status.found || !status.path) return AGENTS.claude.models;
    const abort = new AbortController();
    const activeQuery = query({
      prompt: idleInput(abort.signal),
      options: {
        cwd: homedir(),
        pathToClaudeCodeExecutable: status.path,
        env: this.getEnv(),
        abortController: abort,
        settingSources: ["user"],
        settings: { disableAllHooks: true },
        strictMcpConfig: true,
        persistSession: false,
      },
    });
    const timer = setTimeout(() => abort.abort(), COMMANDS_TIMEOUT_MS);
    try {
      const models = await activeQuery.supportedModels();
      if (models.length === 0) return AGENTS.claude.models;
      this.models = models.map((model) => ({
        // SDK 用 "default" 表示默认模型，这里沿用空串 = 不传 --model
        value: model.value === "default" ? "" : model.value,
        label: model.value === "default" ? AGENTS.claude.models[0]!.label : model.displayName || model.value,
        description: model.description,
        ...(model.supportedEffortLevels?.length ? { efforts: model.supportedEffortLevels } : {}),
      }));
    } catch {
      return AGENTS.claude.models;
    } finally {
      clearTimeout(timer);
      abort.abort();
      activeQuery.close();
    }
    return this.models;
  }

  async listCommands(projectPath: string, sessionKey?: string, sessionId?: string): Promise<SlashCommandOption[]> {
    const active = sessionKey ? this.sessions.get(sessionKey) : undefined;
    if (active) {
      try {
        const current = await active.listCommands();
        if (current) return current;
      } catch {
        // 进程恰好退出时改用独立查询。
      }
    }

    const status = await this.getStatus();
    if (!status.found || !status.path) return [];
    const abort = new AbortController();
    const activeQuery = query({
      prompt: idleInput(abort.signal),
      options: {
        cwd: projectPath,
        ...(active?.sessionId || sessionId ? { resume: active?.sessionId ?? sessionId } : {}),
        pathToClaudeCodeExecutable: status.path,
        env: this.getEnv(),
        abortController: abort,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        persistSession: false,
      },
    });
    const timer = setTimeout(() => abort.abort(), COMMANDS_TIMEOUT_MS);
    try {
      const commands = await activeQuery.supportedCommands();
      return commands.map(({ name, description, argumentHint, aliases }) => ({
        name, description, argumentHint, ...(aliases?.length ? { aliases } : {}),
      }));
    } finally {
      clearTimeout(timer);
      abort.abort();
      activeQuery.close();
    }
  }

  async listMcpStatus(projectPath: string): Promise<{
    name: string; status: string; scope?: string; source?: string; error?: string;
  }[]> {
    const status = await this.getStatus();
    if (!status.found || !status.path) return [];
    const abort = new AbortController();
    const activeQuery = query({
      prompt: idleInput(abort.signal),
      options: {
        cwd: projectPath,
        pathToClaudeCodeExecutable: status.path,
        env: this.getEnv(),
        abortController: abort,
        settingSources: ["user", "project", "local"],
        persistSession: false,
      },
    });
    const timer = setTimeout(() => abort.abort(), COMMANDS_TIMEOUT_MS);
    try {
      return await activeQuery.mcpServerStatus();
    } finally {
      clearTimeout(timer);
      abort.abort();
      activeQuery.close();
    }
  }

  /** 起一个空闲的 SDK 进程读 /usage 的额度数据，不发消息、不消耗 token。 */
  async getQuota(): Promise<AgentQuota> {
    const status = await this.getStatus();
    if (!status.found || !status.path) return quotaError("claude", "未找到 claude 命令");
    const abort = new AbortController();
    const activeQuery = query({
      prompt: idleInput(abort.signal),
      options: {
        cwd: homedir(),
        pathToClaudeCodeExecutable: status.path,
        env: this.getEnv(),
        abortController: abort,
        // 只读用户设置（登录方式可能在里面），不跑 hook、不起 MCP、不落会话文件
        settingSources: ["user"],
        settings: { disableAllHooks: true },
        strictMcpConfig: true,
        persistSession: false,
      },
    });
    const timer = setTimeout(() => abort.abort(), QUOTA_TIMEOUT_MS);
    try {
      const usage = await activeQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      return claudeQuota(usage);
    } catch (error) {
      return quotaError("claude", abort.signal.aborted ? "读取额度超时" : error);
    } finally {
      clearTimeout(timer);
      abort.abort();
      activeQuery.close();
    }
  }

  listSessions(): Promise<SessionSummary[]> {
    return this.history.all();
  }

  loadSession(id: string, projectPath: string): Promise<SessionLoadResult> {
    return this.history.load(id, projectPath);
  }

  renameSession(id: string, projectPath: string, title: string): Promise<void> {
    return this.history.rename(id, projectPath, title);
  }

  deleteSession(id: string, projectPath: string): Promise<void> {
    return this.history.delete(id, projectPath);
  }

  forkSession(params: ForkParams): Promise<SessionSummary | null> {
    if ([...this.sessions.values()].some((session) => session.sessionId === params.ref.id && session.isBusy)) {
      throw new Error("会话正在运行，请等本轮结束后再分叉");
    }
    return this.history.fork(params);
  }

  async resumeCommand(sessionId: string): Promise<string[]> {
    const status = await this.getStatus();
    return [status.path ?? "claude", "--resume", sessionId];
  }

  hasSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  async send(params: ChatSendParams): Promise<{ sessionKey: string }> {
    let session = this.sessions.get(params.sessionKey);
    if (!session) {
      const status = await this.getStatus();
      if (!status.found || !status.path) {
        throw new Error("未找到 claude 命令，请在设置中指定路径");
      }
      session = new ClaudeSession(
        {
          claudePath: status.path,
          env: this.getEnv(),
          emitRows: (key, ops) => this.events.rows(key, ops),
          emitState: (event) => this.events.state(event),
          emitPermission: (event) => {
            this.interactionOwner.set(event.interactionId, event.sessionKey);
            this.events.permission(event);
          },
          emitPermissionResolved: (event) => {
            this.interactionOwner.delete(event.interactionId);
            this.events.permissionResolved(event);
          },
          onSessionId: (_key, _sessionId, projectPath) => {
            this.history.invalidate([projectPath]);
          },
          onQuotaChanged: () => this.events.quotaStale("claude"),
          onCommandsChanged: (key, commands) => this.events.commands(key, commands),
        },
        {
          key: params.sessionKey,
          projectPath: params.projectPath,
          ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
          permissionMode: params.permissionMode,
          ...(params.model ? { model: params.model } : {}),
          ...(params.effort ? { effort: params.effort } : {}),
        },
      );
      this.sessions.set(session.key, session);
      if (params.resumeSessionId) {
        const records = await this.history.loadRecords(params.resumeSessionId, params.projectPath);
        session.seedHistory(records);
      }
      session.emitState();
    } else {
      if (session.permissionMode !== params.permissionMode) await session.setPermissionMode(params.permissionMode);
      if (session.effort !== (params.effort || undefined)) await session.setEffort(params.effort ?? "");
    }
    session.send(params.text, params.images, params.files);
    return { sessionKey: session.key };
  }

  private require(sessionKey: string): ClaudeSession {
    const session = this.sessions.get(sessionKey);
    if (!session) throw new Error("会话不存在或已关闭");
    return session;
  }

  async interrupt(sessionKey: string) {
    await this.sessions.get(sessionKey)?.interrupt();
  }

  setPermissionMode(sessionKey: string, mode: PermissionMode) {
    return this.require(sessionKey).setPermissionMode(mode);
  }

  setModel(sessionKey: string, model: string) {
    return this.require(sessionKey).setModel(model);
  }

  closeSession(sessionKey: string) {
    const session = this.sessions.get(sessionKey);
    if (!session || session.isBusy) return;
    session.close();
    this.sessions.delete(sessionKey);
  }

  respondPermission(interactionId: string, decision: PermissionDecision): boolean {
    const owner = this.interactionOwner.get(interactionId);
    if (!owner) return false;
    this.sessions.get(owner)?.respondPermission(interactionId, decision);
    return true;
  }

  startWatching() {
    this.history.startWatching();
  }

  dispose() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.history.stopWatching();
  }
}
