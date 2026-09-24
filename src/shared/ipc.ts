// IPC 契约：preload 暴露的 window.hcode 与主进程 handler 共用同一份定义。
import type {
  AgentKind,
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
} from "./types.js";

/** invoke 通道：名字 → [参数, 返回值] */
export interface InvokeMap {
  "agent:status": [[], AgentStatus[]];
  "agent:models": [[agent: AgentKind], ModelOption[]];
  "projects:list": [[], Project[]];
  "projects:add": [[], Project | null];
  "projects:setPinned": [[path: string, pinned: boolean], void];
  "projects:remove": [[path: string], void];
  "sessions:list": [[projectPath: string], SessionSummary[]];
  "sessions:load": [[ref: SessionRef], SessionLoadResult];
  "sessions:rename": [[ref: SessionRef, title: string], void];
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
  "fs:stageAttachment": [[file: { name: string; data: string }], string];
  "app:openPath": [[path: string], void];
  "app:showInFinder": [[path: string], void];
  "app:openExternal": [[url: string], void];
  "app:openInTerminal": [[cwd: string, session?: { agent: AgentKind; id: string }], void];
  "app:copyText": [[text: string], void];
  "settings:get": [[], Settings];
  "settings:set": [[patch: SettingsPatch], Settings];
}

/** 主进程 → 渲染进程事件 */
export interface EventMap {
  "sessions:indexChanged": { projectPaths: string[] };
  "chat:rows": ChatRowsEvent;
  "chat:state": ChatStateEvent;
  "permission:requested": PermissionRequestEvent;
  "permission:resolved": PermissionResolvedEvent;
  "window:fullscreen": { fullscreen: boolean };
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
  "projects:list",
  "projects:add",
  "projects:setPinned",
  "projects:remove",
  "sessions:list",
  "sessions:load",
  "sessions:rename",
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
  "fs:stageAttachment",
  "app:openPath",
  "app:showInFinder",
  "app:openExternal",
  "app:openInTerminal",
  "app:copyText",
  "settings:get",
  "settings:set",
];

export const EVENT_CHANNELS: readonly EventChannel[] = [
  "sessions:indexChanged",
  "chat:rows",
  "chat:state",
  "permission:requested",
  "permission:resolved",
  "window:fullscreen",
];
