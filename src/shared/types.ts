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

export interface SlashCommandOption {
  /** 不含前导 / 的命令名。 */
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  /** Codex 技能在界面用 / 补全，发送时转换为 app-server 的 skill 输入项。 */
  kind?: "skill";
}

export interface SlashCommandsEvent {
  sessionKey: string;
  commands: SlashCommandOption[];
}

export interface AgentStatus {
  kind: AgentKind;
  found: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export type ExtensionAgent = "claude" | "codex";

export interface McpEntry {
  name: string;
  scope: string;
  status: string;
  enabled: boolean;
  canToggle: boolean;
  canRemove: boolean;
  detail?: string;
}

export interface SkillEntry {
  name: string;
  description: string;
  path: string;
  scope: string;
  enabled: boolean;
  canToggle: boolean;
}

export interface ExtensionsSnapshot {
  mcp: McpEntry[];
  skills: SkillEntry[];
}

export interface McpAddParams {
  agent: ExtensionAgent;
  projectPath: string;
  name: string;
  scope: "user" | "project" | "local";
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
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

export interface SessionSearchResult {
  session: SessionSummary;
  /** 标题命中时为空；正文命中时指向会话时间线中的行。 */
  rowId: number | null;
  snippet: string;
  kind: "title" | "user" | "assistant" | "reasoning" | "tool";
}

export interface GitBranches {
  /** 当前分支；detached HEAD 时为 null。 */
  current: string | null;
  /** 本地分支，最近提交的在前。 */
  branches: string[];
}

export interface GitTurnFile {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  patch: string | null;
  /** 大文件或二进制文件只列出，不传输内容。 */
  previewUnavailable?: boolean;
  /** 没有可安全恢复的发送前内容时，禁用撤销并说明原因。 */
  revertUnavailable?: string;
  /** 内容指纹用于判断重建预览与当时是否一致；不保存文件正文。 */
  beforeHash?: string | null;
  afterHash?: string | null;
}

export interface GitTurnDiff {
  /** Git 仓库根目录；文件路径均相对于此目录。 */
  root?: string;
  files: GitTurnFile[];
  error?: string;
  id?: string;
  head?: string | null;
  recordedAt?: number;
  prompt?: string;
}

/** 持久化的轮次摘要，不包含文件正文、patch 或可写的 Git 快照。 */
export interface GitTurnRecord {
  id: string;
  root: string;
  head: string | null;
  recordedAt: number;
  prompt: string;
  files: Pick<GitTurnFile, "path" | "status" | "additions" | "deletions" | "beforeHash" | "afterHash" | "previewUnavailable">[];
}

export interface GitTurnPreview {
  files: { path: string; patch: string | null; changed: boolean; baselineChanged: boolean }[];
}

export interface SessionRef {
  agent: AgentKind;
  id: string;
  projectPath: string;
}

/** fork：保留到这条消息所在轮（含回复）；rewind：只保留这条消息之前的内容，消息退回输入框。 */
export type ForkMode = "fork" | "rewind";

export interface ForkParams {
  ref: SessionRef;
  /** 第几条用户消息（从 0 开始）。 */
  turnIndex: number;
  /** 界面上的用户消息总数，用于核对会话记录没有变化。 */
  turnCount: number;
  mode: ForkMode;
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
  usage?: ChatUsage;
}

/** 当前会话最近一轮的用量。 */
export interface ChatUsage {
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  contextUsedPercent?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** 某天、某 CLI、某模型累计的 Token 与完成的轮数。 */
export interface UsageBucket {
  input: number;
  output: number;
  turns: number;
}

/** 本地日期（YYYY-MM-DD）→ CLI → 模型 → 累计用量；只统计 HCode 内发起的轮次。 */
export type UsageStats = Record<string, Partial<Record<AgentKind, Record<string, UsageBucket>>>>;

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

/** 触发通知的事件，每种事件各有一条提示音。 */
export type NotificationEvent = "start" | "done" | "error" | "approval";

/** system：系统默认提示音；xiao：内置语音；custom：用户选的音频文件；none：静音。 */
export type NotificationSound = "system" | "xiao" | "custom" | "none";

export type InterfaceMode = "coding" | "office";

export function normalizeInterfaceMode(value: unknown): InterfaceMode {
  return value === "office" ? "office" : "coding";
}

/** 应用背景：path 为本地图片/视频文件（空串 = 不启用）；blur 为模糊半径（px），mask 为蒙层不透明度（0-100）。 */
export interface BackgroundSettings {
  path: string;
  blur: number;
  mask: number;
}

export const BACKGROUND_VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "m4v"];
export const BACKGROUND_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"];

export const isBackgroundVideo = (path: string) =>
  BACKGROUND_VIDEO_EXTENSIONS.includes(path.split(".").at(-1)?.toLowerCase() ?? "");

export interface Settings {
  theme: "system" | "light" | "dark";
  locale: "zh-CN" | "en-US";
  /** 编程模式展示命令和改动细节；办公模式侧重摘要与结果。 */
  interfaceMode: InterfaceMode;
  /** 新建会话默认使用的 CLI。 */
  defaultAgent: AgentKind;
  /** 各 CLI 可执行文件路径；空串 = 自动查找。 */
  agentPaths: Record<AgentKind, string>;
  defaultPermissionModes: Record<AgentKind, PermissionMode>;
  defaultModels: Record<AgentKind, string>;
  /** 输入框里最近选择的思考强度（空串 = CLI 默认），新建会话沿用。 */
  defaultEfforts: Record<AgentKind, string>;
  /** 置顶会话的 agent:sessionId 键；仅影响所属项目内的会话排序。 */
  pinnedSessions: string[];
  /** 有会话正在运行时阻止电脑休眠（显示器仍可关闭）。 */
  preventSleepWhileRunning: boolean;
  /** 任务开始、完成、出错或等待审批时通知；后台发送系统通知。 */
  notifyOnFinish: boolean;
  notificationSound: NotificationSound;
  /** notificationSound 为 custom 时各事件的音频文件路径；空串 = 用系统提示音。 */
  customSounds: Record<NotificationEvent, string>;
  background: BackgroundSettings;
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
  interfaceMode: "coding",
  defaultAgent: "claude",
  agentPaths: { claude: "", codex: "", step: "", agy: "", pi: "" },
  defaultPermissionModes: { claude: "default", codex: "on-request", step: "ask", agy: "default", pi: "default" },
  defaultModels: { claude: "", codex: "", step: "", agy: "", pi: "" },
  defaultEfforts: { claude: "", codex: "", step: "", agy: "", pi: "" },
  pinnedSessions: [],
  preventSleepWhileRunning: true,
  notifyOnFinish: true,
  notificationSound: "system",
  customSounds: { start: "", done: "", error: "", approval: "" },
  background: { path: "", blur: 20, mask: 60 },
};
