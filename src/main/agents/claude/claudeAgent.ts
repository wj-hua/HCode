// Claude Code 接入：历史 + 实时会话 + 审批的统一入口。
import { join } from "node:path";
import { homedir } from "node:os";
import { AGENTS } from "../../../shared/agents.js";
import type {
  AgentStatus,
  ChatSendParams,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  SessionLoadResult,
  SessionSummary,
} from "../../../shared/types.js";
import { probeCli } from "../../util/locateCli.js";
import type { AgentEvents, AgentProvider } from "../types.js";
import { ClaudeHistory } from "./claudeHistory.js";
import { ClaudeSession } from "./claudeSession.js";

export class ClaudeAgent implements AgentProvider {
  readonly kind = "claude" as const;
  private readonly history: ClaudeHistory;
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly interactionOwner = new Map<string, string>();
  private status: AgentStatus | null = null;

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

  async listModels(): Promise<ModelOption[]> {
    return AGENTS.claude.models;
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
        },
        {
          key: params.sessionKey,
          projectPath: params.projectPath,
          ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
          permissionMode: params.permissionMode,
          ...(params.model ? { model: params.model } : {}),
        },
      );
      this.sessions.set(session.key, session);
      if (params.resumeSessionId) {
        const records = await this.history.loadRecords(params.resumeSessionId, params.projectPath);
        session.seedHistory(records);
      }
      session.emitState();
    } else if (session.permissionMode !== params.permissionMode) {
      await session.setPermissionMode(params.permissionMode);
    }
    session.send(params.text);
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
