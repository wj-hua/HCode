// IPC 契约：preload 暴露的 window.hcode 与主进程 handler 共用同一份定义。
import type {
  AgentKind,
  AgentQuota,
  AgentStatus,
  ModelOption,
  ChatRowsEvent,
  ChatSendParams,
  ChatStateEvent,
  GitBranches,
  PermissionDecision,
  PermissionMode,
  PermissionRequestEvent,
  PermissionResolvedEvent,
  Project,
  SessionLoadResult,
  SessionRef,
  SessionSummary,
  Settings,
  SettingsPatch,
  SlashCommandOption,
  SlashCommandsEvent,
} from "./types.js";

/** invoke 通道：名字 → [参数, 返回值] */
export interface InvokeMap {
  "agent:status": [[], AgentStatus[]];
  "agent:models": [[agent: AgentKind], ModelOption[]];
  "agent:commands": [[agent: AgentKind, projectPath: string, sessionKey?: string, sessionId?: string], SlashCommandOption[]];
  /** 各 CLI 的订阅额度；force 时忽略主进程缓存。 */
  "quota:list": [[force?: boolean], AgentQuota[]];
  "projects:list": [[], Project[]];
  "projects:add": [[], Project | null];
  "projects:setPinned": [[path: string, pinned: boolean], void];
  "projects:reorder": [[paths: string[]], void];
  "projects:remove": [[path: string], void];
  "sessions:list": [[projectPath: string], SessionSummary[]];
  "sessions:load": [[ref: SessionRef], SessionLoadResult];
  "sessions:rename": [[ref: SessionRef, title: string], void];
  "sessions:delete": [[ref: SessionRef], void];
  "chat:send": [[params: ChatSendParams], { sessionKey: string }];
  "chat:interrupt": [[sessionKey: string], void];
  "chat:setPermissionMode": [[sessionKey: string, mode: PermissionMode], void];
  "chat:setModel": [[sessionKey: string, model: string], void];
  "chat:close": [[sessionKey: string], void];
  "permission:respond": [[interactionId: string, decision: PermissionDecision], void];
  "git:branches": [[cwd: string], GitBranches | null];
  "git:switchBranch": [[cwd: string, branch: string], void];
  "fs:readText": [[path: string, maxBytes?: number], string | null];
  "fs:stat": [[path: string], { exists: boolean; isDirectory: boolean; size: number } | null];
  "fs:listProjectFiles": [[cwd: string, query: string], string[]];
  "fs:stageAttachment": [[file: { name: string; data: string }], string];
  /** 读取提示音文件；不存在、不是文件或超过大小上限时返回 null。 */
  "fs:readAudio": [[path: string], Uint8Array | null];
  /** 弹出文件选择框挑一个音频文件，取消返回 null。 */
  "app:pickAudio": [[], string | null];
  "app:openPath": [[path: string], void];
  "app:showInFinder": [[path: string], void];
  "app:openExternal": [[url: string], void];
  "app:openInTerminal": [[cwd: string, session?: { agent: AgentKind; id: string }], void];
  "app:copyText": [[text: string], void];
  /** 显示并聚焦主窗口（点击系统通知时用）。 */
  "app:focusWindow": [[], void];
  "settings:get": [[], Settings];
  "settings:set": [[patch: SettingsPatch], Settings];
}

/** 主进程 → 渲染进程事件 */
export interface EventMap {
  "sessions:indexChanged": { projectPaths: string[] };
  "chat:rows": ChatRowsEvent;
  "chat:state": ChatStateEvent;
  "chat:commands": SlashCommandsEvent;
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
  "quota:list",
  "projects:list",
  "projects:add",
  "projects:setPinned",
  "projects:reorder",
  "projects:remove",
  "sessions:list",
  "sessions:load",
  "sessions:rename",
  "sessions:delete",
  "chat:send",
  "chat:interrupt",
  "chat:setPermissionMode",
  "chat:setModel",
  "chat:close",
  "permission:respond",
  "git:branches",
  "git:switchBranch",
  "fs:readText",
  "fs:stat",
  "fs:listProjectFiles",
  "fs:stageAttachment",
  "fs:readAudio",
  "app:pickAudio",
  "app:openPath",
  "app:showInFinder",
  "app:openExternal",
  "app:openInTerminal",
  "app:copyText",
  "app:focusWindow",
  "settings:get",
  "settings:set",
];

export const EVENT_CHANNELS: readonly EventChannel[] = [
  "sessions:indexChanged",
  "chat:rows",
  "chat:state",
  "chat:commands",
  "permission:requested",
  "permission:resolved",
  "window:fullscreen",
  "quota:updated",
];
