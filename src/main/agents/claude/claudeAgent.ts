// Claude Code 接入：历史 + 实时会话 + 审批的统一入口。
import type {
  AgentStatus,
  ChatSendParams,
  ChatStateEvent,
  PermissionDecision,
  PermissionMode,
  PermissionRequestEvent,
  PermissionResolvedEvent,
  RowOp,
} from "../../../shared/types.js";
import { ClaudeHistory } from "./claudeHistory.js";
import { probeClaude } from "./claudeLocate.js";
import { ClaudeSession } from "./claudeSession.js";

export interface ClaudeAgentEvents {
  rows(sessionKey: string, ops: RowOp[]): void;
  state(event: ChatStateEvent): void;
  permission(event: PermissionRequestEvent): void;
  permissionResolved(event: PermissionResolvedEvent): void;
  indexChanged(projectPaths: string[]): void;
}

export class ClaudeAgent {
  readonly history: ClaudeHistory;
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly interactionOwner = new Map<string, string>();
  private status: AgentStatus | null = null;

  constructor(
    private readonly events: ClaudeAgentEvents,
    private readonly getEnv: () => Record<string, string>,
    private readonly getPathOverride: () => string,
  ) {
    this.history = new ClaudeHistory((paths) => events.indexChanged(paths));
  }

  async getStatus(refresh = false): Promise<AgentStatus> {
    if (!this.status || refresh) {
      this.status = await probeClaude(this.getEnv(), this.getPathOverride());
    }
    return this.status;
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
    } else {
      if (session.permissionMode !== params.permissionMode) {
        await session.setPermissionMode(params.permissionMode);
      }
    }
    session.send(params.text);
    return { sessionKey: session.key };
  }

  private require(sessionKey: string): ClaudeSession {
    const session = this.sessions.get(sessionKey);
    if (!session) throw new Error("会话不存在或已关闭");
    return session;
  }

  interrupt(sessionKey: string) {
    return this.sessions.get(sessionKey)?.interrupt();
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

  respondPermission(interactionId: string, decision: PermissionDecision) {
    const owner = this.interactionOwner.get(interactionId);
    if (!owner) return;
    this.sessions.get(owner)?.respondPermission(interactionId, decision);
  }

  dispose() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.history.stopWatching();
  }
}
