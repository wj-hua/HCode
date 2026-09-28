// 每个 CLI 接入实现一个 AgentProvider；AgentRegistry 负责按 agent / sessionKey / interactionId 路由。
import type {
  AgentKind,
  AgentQuota,
  AgentStatus,
  ChatSendParams,
  ChatStateEvent,
  ForkParams,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PermissionRequestEvent,
  PermissionResolvedEvent,
  RowOp,
  SessionLoadResult,
  SessionSummary,
  SlashCommandOption,
} from "../../shared/types.js";

export interface AgentEvents {
  rows(sessionKey: string, ops: RowOp[]): void;
  state(event: ChatStateEvent): void;
  commands(sessionKey: string, commands: SlashCommandOption[]): void;
  permission(event: PermissionRequestEvent): void;
  permissionResolved(event: PermissionResolvedEvent): void;
  indexChanged(projectPaths: string[]): void;
  /** 额度可能已变化（一轮对话结束、CLI 推送了额度更新），由 QuotaService 稍后重新读取。 */
  quotaStale(agent: AgentKind): void;
}

export interface AgentProvider {
  readonly kind: AgentKind;
  getStatus(refresh?: boolean): Promise<AgentStatus>;
  listModels(): Promise<ModelOption[]>;
  listCommands?(projectPath: string, sessionKey?: string, sessionId?: string): Promise<SlashCommandOption[]>;
  /** 订阅额度（5 小时 / 每周）；不支持的 CLI 不实现。 */
  getQuota?(): Promise<AgentQuota>;
  /** 全部历史会话（按更新时间倒序）。 */
  listSessions(): Promise<SessionSummary[]>;
  /** 已知的会话原始记录文件路径，供全文搜索预筛；未提供时直接读取历史投影。 */
  sessionFilePath?(id: string): string | undefined;
  loadSession(id: string, projectPath: string): Promise<SessionLoadResult>;
  renameSession(id: string, projectPath: string, title: string): Promise<void>;
  /** 删除会话（Codex 为归档）；会话文件移到废纸篓。调用前 HCode 里的活动会话需已关闭。 */
  deleteSession(id: string, projectPath: string): Promise<void>;
  /** 从某条用户消息分叉出新会话，原会话不变；回退到第一条消息之前时返回 null。 */
  forkSession?(params: ForkParams): Promise<SessionSummary | null>;
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
