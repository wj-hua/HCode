// 主进程与渲染进程共用的数据类型（只放纯类型，不放实现）。
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

export type { ConversationRow };

/** 以后接入 pi 等 CLI 时在这里扩展。 */
export type AgentKind = "claude" | "codex" | "step" | "agy" | "pi";

/** 各 CLI 的权限模式取值不同，可选值见 shared/agents.ts 的 AGENTS[kind].permissionModes。 */
export type PermissionMode = string;

export interface ModelOption {
  /** 传给 CLI 的模型标识；空串 = CLI 默认模型。 */
  value: string;
  label: string;
  description?: string;
  /** 该模型可选的思考强度（按由低到高排列）；为空表示不支持调节。 */
  efforts?: string[];
}

export interface AgentStatus {
  kind: AgentKind;
  found: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export interface Project {
  /** 项目绝对路径（即 CLI 的 cwd），作为唯一键。 */
  path: string;
  name: string;
  lastActiveAt: number;
  sessionCount: number;
  pinned: boolean;
  exists: boolean;
}

export interface SessionSummary {
  id: string;
  agent: AgentKind;
  projectPath: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  gitBranch?: string;
  /** 这个会话正开在某个终端里的 claude 进程中（继续发送可能与之冲突）。 */
  activeInTerminal?: boolean;
}

export interface GitBranches {
  /** 当前分支；detached HEAD 时为 null。 */
  current: string | null;
  /** 本地分支，最近提交的在前。 */
  branches: string[];
}

export interface SessionRef {
  agent: AgentKind;
  id: string;
  projectPath: string;
}

export interface SessionLoadResult {
  summary: SessionSummary | null;
  rows: ConversationRow[];
}

/**
 * 增量行操作，按 ZCode v4 的语义：结构变化整行替换（upsert），文本增长用追加（append）。
 */
export type RowOp =
  | { op: "upsert"; row: ConversationRow }
  | { op: "append"; rowId: number; field: "text" | "inputText"; text: string }
  | { op: "reset"; rows: ConversationRow[] };

export type ChatRunState = "idle" | "running" | "awaitingApproval" | "error";

export interface ChatRowsEvent {
  sessionKey: string;
  ops: RowOp[];
}

export interface ChatStateEvent {
  sessionKey: string;
  agent: AgentKind;
  sessionId?: string;
  projectPath: string;
  state: ChatRunState;
  error?: string;
  permissionMode: PermissionMode;
  model?: string;
}

export interface PermissionRequestEvent {
  sessionKey: string;
  interactionId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  /** Claude 给出的“本会话总是允许”规则；为空时不提供该选项。 */
  canAllowForSession: boolean;
  defaultToNo?: boolean;
}

export interface PermissionResolvedEvent {
  sessionKey: string;
  interactionId: string;
}

export type PermissionDecision =
  | { decision: "allow"; updatedInput?: Record<string, unknown> }
  | { decision: "allowSession" }
  | { decision: "deny"; message?: string; interrupt?: boolean };

/** 随消息发送的图片。 */
export interface ImageInput {
  /** base64，不带 data: 前缀 */
  data: string;
  mimeType: string;
  name?: string;
}

/** 本机文件附件。CLI 通过绝对路径读取，避免把视频等大文件塞进 IPC 消息。 */
export interface FileInput {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface ChatSendParams {
  agent: AgentKind;
  /** 会话 key，由渲染进程生成；主进程找不到时用它新建会话，保证事件先于 invoke 返回也能对上。 */
  sessionKey: string;
  /** 要续聊的历史会话 id。 */
  resumeSessionId?: string;
  projectPath: string;
  text: string;
  images?: ImageInput[];
  files?: FileInput[];
  permissionMode: PermissionMode;
  model?: string;
  /** 思考强度；不传 = CLI 默认。 */
  effort?: string;
}

/** 额度窗口：5 小时滚动窗口、周窗口，或其他时长。 */
export type QuotaWindowKind = "5h" | "weekly" | "other";

export interface QuotaWindow {
  kind: QuotaWindowKind;
  /** 显示名，如 “5 小时”“每周”“每周 · Opus”。 */
  label: string;
  /** 已用百分比，0–100。 */
  usedPercent: number;
  /** 重置时间（毫秒时间戳）。 */
  resetsAt?: number;
}

/** 共用同一组额度的模型（如 agy 的 “Gemini Models”）；只有一组时 name 为空。 */
export interface QuotaGroup {
  name?: string;
  windows: QuotaWindow[];
}

/** 额度来源：各 CLI，外加不属于某个 CLI 的 GLM Coding Plan（按 API key 读取）。 */
export type QuotaSource = AgentKind | "glm";

export interface AgentQuota {
  agent: QuotaSource;
  /** unavailable：该登录方式没有订阅额度（API key 等）；error：读取失败。 */
  status: "ok" | "unavailable" | "error";
  message?: string;
  /** 订阅档位，如 max、plus。 */
  plan?: string;
  groups: QuotaGroup[];
  updatedAt: number;
}

export interface Settings {
  theme: "system" | "light" | "dark";
  locale: "zh-CN" | "en-US";
  /** 新建会话默认使用的 CLI。 */
  defaultAgent: AgentKind;
  /** 各 CLI 可执行文件路径；空串 = 自动查找。 */
  agentPaths: Record<AgentKind, string>;
  defaultPermissionModes: Record<AgentKind, PermissionMode>;
  defaultModels: Record<AgentKind, string>;
  /** 输入框里最近选择的思考强度（空串 = CLI 默认），新建会话沿用。 */
  defaultEfforts: Record<AgentKind, string>;
}

/** 按 CLI 分组的设置项。 */
type PerAgentSettingKey = "agentPaths" | "defaultPermissionModes" | "defaultModels" | "defaultEfforts";

/** settings:set 的补丁：按 CLI 分组的字段只需传要改的 CLI，主进程逐项合并。 */
export type SettingsPatch = Partial<Omit<Settings, PerAgentSettingKey>> & {
  [K in PerAgentSettingKey]?: Partial<Settings[K]>;
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  locale: "zh-CN",
  defaultAgent: "claude",
  agentPaths: { claude: "", codex: "", step: "", agy: "", pi: "" },
  defaultPermissionModes: { claude: "default", codex: "on-request", step: "ask", agy: "default", pi: "default" },
  defaultModels: { claude: "", codex: "", step: "", agy: "", pi: "" },
  defaultEfforts: { claude: "", codex: "", step: "", agy: "", pi: "" },
};
