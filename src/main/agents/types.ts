// 每个 CLI 接入实现一个 AgentProvider；AgentRegistry 负责按 agent / sessionKey / interactionId 路由。
import type {
  AgentKind,
  AgentQuota,
  AgentStatus,
  ChatSendParams,
  ConversationRow,
  ChatStateEvent,
  ChatPromptSuggestionEvent,
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
import type { TurnOutcome } from "../../shared/collaboration.js";
import type { ResearchRuntime, HostedRuntime } from "../sessions/researchRuntime.js";

/** 内部执行身份由主进程生成，不能由 Renderer 指定。 */
export interface AgentSendParams extends ChatSendParams {
  /** 委派任务的持久化屏障；Codex 必须保存原生身份后才开始执行，失败不得发送任务。 */
  onNativeSession?(nativeSessionId: string): Promise<void>;
  executionTurnId?: string;
  research?: ResearchRuntime;
  hosted?: HostedRuntime;
  /** 普通续聊的宿主交接；不属于用户消息，不赋予额外工具或权限。 */
  ordinaryContinuation?: string;
}

export interface AgentEvents {
  turnOutcome?(event: TurnOutcome): void;
  rows(sessionKey: string, ops: RowOp[]): void;
  state(event: ChatStateEvent): void;
  promptSuggestion?(event: ChatPromptSuggestionEvent): void;
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
  send(params: AgentSendParams): Promise<{ sessionKey: string }>;
  hasSession(sessionKey: string): boolean;
  /** 活动会话的当前全部行（先发出缓冲中的增量）；会话不存在时返回 undefined。 */
  liveRows(sessionKey: string): ConversationRow[] | undefined;
  /** 在可信终态后移除临时研究工具并恢复会话原权限；不创建新身份。 */
  endResearch?(sessionKey: string, mode: PermissionMode): Promise<void>;
  /** 当前原生线程能否发起协作；返回明确限制，不偷偷创建替代线程。 */
  collaborationSourceReason?(sessionId: string): Promise<string | undefined>;
  interrupt(sessionKey: string): Promise<void>;
  setPermissionMode(sessionKey: string, mode: PermissionMode): Promise<void>;
  setModel(sessionKey: string, model: string): Promise<void>;
  closeSession(sessionKey: string): void;
  /** 返回 true 表示该审批属于这个 provider 并已处理。 */
  respondPermission(interactionId: string, decision: PermissionDecision): boolean;
  startWatching(): void;
  dispose(): void;
}
