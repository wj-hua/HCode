// 每个 CLI 接入实现一个 AgentProvider；AgentRegistry 负责按 agent / sessionKey / interactionId 路由。
import type {
  AgentKind,
  AgentStatus,
  ChatSendParams,
  ChatStateEvent,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PermissionRequestEvent,
  PermissionResolvedEvent,
  RowOp,
  SessionLoadResult,
  SessionSummary,
} from "../../shared/types.js";

export interface AgentEvents {
  rows(sessionKey: string, ops: RowOp[]): void;
  state(event: ChatStateEvent): void;
  permission(event: PermissionRequestEvent): void;
  permissionResolved(event: PermissionResolvedEvent): void;
  indexChanged(projectPaths: string[]): void;
}

export interface AgentProvider {
  readonly kind: AgentKind;
  getStatus(refresh?: boolean): Promise<AgentStatus>;
  listModels(): Promise<ModelOption[]>;
  /** 全部历史会话（按更新时间倒序）。 */
  listSessions(): Promise<SessionSummary[]>;
  loadSession(id: string, projectPath: string): Promise<SessionLoadResult>;
  renameSession(id: string, projectPath: string, title: string): Promise<void>;
  /** 在终端里继续该会话的命令行（不含 cd）。 */
  resumeCommand(sessionId: string): Promise<string[]>;
  send(params: ChatSendParams): Promise<{ sessionKey: string }>;
  hasSession(sessionKey: string): boolean;
  interrupt(sessionKey: string): Promise<void>;
  setPermissionMode(sessionKey: string, mode: PermissionMode): Promise<void>;
  setModel(sessionKey: string, model: string): Promise<void>;
  closeSession(sessionKey: string): void;
  /** 返回 true 表示该审批属于这个 provider 并已处理。 */
  respondPermission(interactionId: string, decision: PermissionDecision): boolean;
  startWatching(): void;
  dispose(): void;
}
