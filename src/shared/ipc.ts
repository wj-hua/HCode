// IPC 契约：preload 暴露的 window.hcode 与主进程 handler 共用同一份定义。
import type {
  AgentKind,
  AgentQuota,
  AgentStatus,
  ModelOption,
  UsageStats,
  ChatRowsEvent,
  ChatSendParams,
  ChatStateEvent,
  GitBranches,
  GitTurnDiff,
  GitTurnRecord,
  GitTurnPreview,
  PermissionDecision,
  PermissionMode,
  PermissionRequestEvent,
  PermissionResolvedEvent,
  Project,
  SessionLoadResult,
  SessionRef,
  SessionSearchResult,
  SessionSummary,
  Settings,
  SettingsPatch,
  SlashCommandOption,
  SlashCommandsEvent,
  ExtensionAgent,
  ExtensionsSnapshot,
  ForkParams,
  McpAddParams,
} from "./types.js";
import type { AppCommand } from "./shortcuts.js";

/** invoke 通道：名字 → [参数, 返回值] */
export interface InvokeMap {
  "agent:status": [[], AgentStatus[]];
  "agent:models": [[agent: AgentKind], ModelOption[]];
  "agent:commands": [[agent: AgentKind, projectPath: string, sessionKey?: string, sessionId?: string], SlashCommandOption[]];
  "extensions:list": [[agent: ExtensionAgent, projectPath: string], ExtensionsSnapshot];
  "extensions:setMcpEnabled": [[agent: ExtensionAgent, projectPath: string, name: string, enabled: boolean], void];
  "extensions:addMcp": [[params: McpAddParams], void];
  "extensions:removeMcp": [[agent: ExtensionAgent, projectPath: string, name: string, scope: string], void];
  "extensions:setSkillEnabled": [[agent: ExtensionAgent, projectPath: string, path: string, name: string, enabled: boolean], void];
  /** 各 CLI 的订阅额度；force 时忽略主进程缓存。 */
  "quota:list": [[force?: boolean], AgentQuota[]];
  "projects:list": [[], Project[]];
  "workspace:conversation": [[], string];
  "projects:add": [[], Project | null];
  "projects:setPinned": [[path: string, pinned: boolean], void];
  "projects:reorder": [[paths: string[]], void];
  "projects:remove": [[path: string], void];
  "sessions:list": [[projectPath: string], SessionSummary[]];
  "sessions:load": [[ref: SessionRef], SessionLoadResult];
  "sessions:search": [[query: string], SessionSearchResult[]];
  "sessions:rename": [[ref: SessionRef, title: string], void];
  /** 删除 / 归档成功后清理置顶记录，返回最新设置。 */
  "sessions:delete": [[ref: SessionRef], Settings];
  /** 分叉出新会话；回退到第一条消息之前时没有可保留的内容，返回 null。 */
  "sessions:fork": [[params: ForkParams], SessionSummary | null];
  "chat:send": [[params: ChatSendParams], { sessionKey: string }];
  "chat:interrupt": [[sessionKey: string], void];
  "chat:setPermissionMode": [[sessionKey: string, mode: PermissionMode], void];
  "chat:setModel": [[sessionKey: string, model: string], void];
  "chat:close": [[sessionKey: string], void];
  "permission:respond": [[interactionId: string, decision: PermissionDecision], void];
  "git:branches": [[cwd: string], GitBranches | null];
  "git:switchBranch": [[cwd: string, branch: string], void];
  "git:isRepository": [[cwd: string], boolean];
  "git:createBranch": [[cwd: string, name: string], void];
  "git:commit": [[sessionKey: string, files: string[], message: string], void];
  "git:revertFile": [[sessionKey: string, file: string], void];
  "git:refreshTurnDiff": [[sessionKey: string], void];
  "git:previewTurn": [[cwd: string, record: GitTurnRecord], GitTurnPreview];
  /** 有界 UTF-8 文本读取（最多 2 MiB）；二进制、超限或读取失败返回 null。 */
  "fs:readText": [[path: string, maxBytes?: number], string | null];
  "fs:stat": [[path: string], { exists: boolean; isDirectory: boolean; size: number } | null];
  "fs:listProjectFiles": [[cwd: string, query: string], string[]];
  "fs:stageAttachment": [[file: { name: string; data: string }], string];
  /** 读取提示音、预览图片等二进制文件（上限 10 MiB）；不存在、不是文件或超限时返回 null。 */
  "fs:readMedia": [[path: string], Uint8Array | null];
  /** 弹出文件选择框挑一个音频文件，取消返回 null。 */
  "app:pickAudio": [[], string | null];
  /** 弹出文件选择框挑一张图片或一个视频作为应用背景，取消返回 null。 */
  "app:pickBackground": [[], string | null];
  "app:openPath": [[path: string], void];
  "app:showInFinder": [[path: string], void];
  "app:openExternal": [[url: string], void];
  "app:openInTerminal": [[cwd: string, session?: { agent: AgentKind; id: string }], void];
  "app:copyText": [[text: string], void];
  /** 弹出保存框写入文本文件，返回保存路径；取消返回 null。 */
  "app:saveText": [[defaultName: string, text: string], string | null];
  /** 显示并聚焦主窗口（点击系统通知时用）。 */
  "app:focusWindow": [[], void];
  "usage:get": [[], UsageStats];
  "usage:clear": [[], void];
  "settings:get": [[], Settings];
  "settings:set": [[patch: SettingsPatch], Settings];
}

/** 主进程 → 渲染进程事件 */
export interface EventMap {
  "app:menuCommand": { command: AppCommand; index?: number; fromAccelerator?: boolean };
  "sessions:indexChanged": { projectPaths: string[] };
  "chat:rows": ChatRowsEvent;
  "chat:state": ChatStateEvent;
  "chat:commands": SlashCommandsEvent;
  "git:turnDiff": { sessionKey: string; diff: GitTurnDiff | null; turnId?: string };
  "permission:requested": PermissionRequestEvent;
  "permission:resolved": PermissionResolvedEvent;
  "window:fullscreen": { fullscreen: boolean };
  "quota:updated": AgentQuota;
}

export type InvokeChannel = keyof InvokeMap;
export type EventChannel = keyof EventMap;

export interface HCodeBridge {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeMap[C][0]): Promise<InvokeMap[C][1]>;
  on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void;
  platform: NodeJS.Platform;
  getPathForFile(file: File): string | null;
}

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  "agent:status",
  "agent:models",
  "agent:commands",
  "extensions:list",
  "extensions:setMcpEnabled",
  "extensions:addMcp",
  "extensions:removeMcp",
  "extensions:setSkillEnabled",
  "quota:list",
  "projects:list",
  "workspace:conversation",
  "projects:add",
  "projects:setPinned",
  "projects:reorder",
  "projects:remove",
  "sessions:list",
  "sessions:load",
  "sessions:search",
  "sessions:rename",
  "sessions:delete",
  "sessions:fork",
  "chat:send",
  "chat:interrupt",
  "chat:setPermissionMode",
  "chat:setModel",
  "chat:close",
  "permission:respond",
  "git:branches",
  "git:switchBranch",
  "git:isRepository",
  "git:createBranch",
  "git:commit",
  "git:revertFile",
  "git:refreshTurnDiff",
  "git:previewTurn",
  "fs:readText",
  "fs:stat",
  "fs:listProjectFiles",
  "fs:stageAttachment",
  "fs:readMedia",
  "app:pickAudio",
  "app:pickBackground",
  "app:openPath",
  "app:showInFinder",
  "app:openExternal",
  "app:openInTerminal",
  "app:copyText",
  "app:saveText",
  "app:focusWindow",
  "usage:get",
  "usage:clear",
  "settings:get",
  "settings:set",
];

export const EVENT_CHANNELS: readonly EventChannel[] = [
  "app:menuCommand",
  "sessions:indexChanged",
  "chat:rows",
  "chat:state",
  "chat:commands",
  "git:turnDiff",
  "permission:requested",
  "permission:resolved",
  "window:fullscreen",
  "quota:updated",
];
