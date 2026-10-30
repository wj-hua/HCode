import type { AdoptionPreview, AdoptionRequest, AdoptionState } from "./codeAdoption.js";
import type {ExpertProfilePreview} from "./expertProfiles.js";
// IPC 契约：preload 暴露的 window.hcode 与主进程 handler 共用同一份定义。
import type {
  AgentKind,
  ComputerBattery,
  AgentQuota,
  AgentStatus,
  ModelOption,
  ChatRowsEvent,
  ChatSendParams,
  ChatSteerParams,
  ChatSteerResult,
  ChatStateEvent,
  GitBranches,
  GitBranchSwitchPreview,
  GitBranchSwitchResult,
  GitCommitAndSwitchResult,
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
import type { CollaborationCapabilities, CollaborationSnapshot, CollaborationStartParams, CollaborationResumeParams, RecoveryIssue } from "./collaboration.js";
import type { ResearchDraft, ResearchDraftInput, ResearchDraftEdit } from "./researchDraft.js";
import type { CodeDraft, CodeDraftInput, CodeDraftEdit } from "./codeDraft.js";
import type { ExpertDraft, ExpertDraftInput, ExpertDraftEdit } from "./expertDraft.js";
import type { ExpertStartParams, ExpertResumeParams } from './experts.js';
import type { MemoryEntry, MemorySaveInput } from './memory.js';

import type { CodeAdmission, CandidatePreview } from "./codeDelivery.js";

export interface ProjectDirectoryListing {
  path: string;
  parent: string | null;
  directories: { name: string; path: string; isSymbolicLink: boolean }[];
}

/** invoke 通道：名字 → [参数, 返回值] */
export interface InvokeMap {
  "system:battery": [[], ComputerBattery | null];
  "memory:list": [[], MemoryEntry[]];
  "memory:save": [[entry: MemorySaveInput], MemoryEntry];
  "memory:delete": [[id: string], void];
  "terminal:create": [[id: string, cwd: string, cols: number, rows: number], string];
  "terminal:write": [[id: string, data: string], void];
  "terminal:resize": [[id: string, cols: number, rows: number], void];
  "terminal:close": [[id: string], void];
  "agentInvocation:list": [[sessionKey: string, sessionId?: string], import('./agentInvocation.js').AgentInvocation[]];
  "agentInvocation:cancel": [[id: string], void];
  "collaboration:presentation": [[], import("./collaborationPresentation.js").PresentationCatalog];
  "collaboration:codeDraftCreate": [[input: CodeDraftInput], CodeDraft];
  "collaboration:codeDraftList": [[sessionKey?: string, nativeSessionId?: string], CodeDraft[]];
  "collaboration:codeDraftUpdate": [[id: string, revision: number, edit: CodeDraftEdit], CodeDraft];
  "collaboration:codeDraftPrepare": [[id: string, revision: number], CodeDraft];
  "collaboration:codeDraftConfirm": [[id: string, revision: number], CollaborationSnapshot];
  "collaboration:codeDraftCancel": [[id: string], void];
  "collaboration:codeDraftAbandon": [[id: string, revision: number], CodeDraft];
  "collaboration:expertDraftCreate": [[input: ExpertDraftInput], ExpertDraft];
  "collaboration:expertDraftList": [[sessionKey?: string, nativeSessionId?: string], ExpertDraft[]];
  "collaboration:expertDraftUpdate": [[id: string, revision: number, edit: ExpertDraftEdit], ExpertDraft];
  "collaboration:expertDraftPrepare": [[id: string, revision: number], ExpertDraft];
  "collaboration:expertDraftConfirm": [[id: string, revision: number], CollaborationSnapshot];
  "collaboration:expertDraftCancel": [[id: string], void];
  "collaboration:expertDraftAbandon": [[id: string, revision: number], ExpertDraft];
  "collaboration:draftCreate": [[input: ResearchDraftInput], ResearchDraft];
  "collaboration:draftList": [[sessionKey?: string, nativeSessionId?: string], ResearchDraft[]];
  "collaboration:draftUpdate": [[id: string, revision: number, edit: ResearchDraftEdit], ResearchDraft];
  "collaboration:draftPrepare": [[id: string, revision: number], ResearchDraft];
  "collaboration:draftConfirm": [[id: string, revision: number], CollaborationSnapshot];
  "collaboration:draftCancel": [[id: string], void];
  "collaboration:draftAbandon": [[id: string, revision: number], ResearchDraft];
  "collaboration:codeAdmission": [[path: string], CodeAdmission];
  "collaboration:candidatePreview": [[id: string, versionId: string], CandidatePreview];
  "collaboration:adoptionPreview": [[id: string, versionId: string], AdoptionPreview];
  "collaboration:applyCandidate": [[id: string, request: AdoptionRequest], AdoptionState];
  "collaboration:recoverAdoption": [[id: string, adoptionId: string], AdoptionState];
  "collaboration:candidateAction": [[id: string, action: "manual" | "discard" | "cleanup", deliveryId?: string], string];
  "collaboration:capabilities": [[source?: import("./collaboration.js").CollaborationSource], CollaborationCapabilities[]];
  "collaboration:start": [[params: CollaborationStartParams], CollaborationSnapshot];
  "collaboration:expertProfiles": [[projectPath:string], ExpertProfilePreview[]];
  "collaboration:startExperts": [[params: ExpertStartParams], CollaborationSnapshot];
  "collaboration:resumeExperts": [[id:string,params:ExpertResumeParams],void];
  "collaboration:get": [[id: string], CollaborationSnapshot];
  "collaboration:list": [[sessionKey: string, sessionId?: string], CollaborationSnapshot[]];
  "collaboration:cancel": [[id: string], void];
  "collaboration:pause": [[id: string], void];
  "collaboration:resume": [[id: string, params: CollaborationResumeParams], void];
  "collaboration:reply": [[id: string, messageId: string, text: string], void];
  "collaboration:supplement": [[id: string, targetId: string, text: string], void];
  "collaboration:takeover": [[id: string], void];
  "collaboration:cancelDelivery": [[id: string, deliveryId: string], void];
  "collaboration:recoveryIssues": [[], RecoveryIssue[]];
  "collaboration:repair": [[id: string], CollaborationSnapshot];
  "collaboration:artifact": [[runId: string, versionId: string], { text: string; markdown: string; report: import("./collaboration.js").CollaborationReport }];
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
  "projects:list": [[refresh?: boolean], Project[]];
  "workspace:conversation": [[], string];
  "projects:add": [[], Project | null];
  "projects:addPath": [[path: string, create: boolean], Project];
  "projects:browseDirectories": [[path: string | null, showHidden: boolean], ProjectDirectoryListing];
  "projects:setPinned": [[path: string, pinned: boolean], void];
  "projects:reorder": [[paths: string[]], void];
  "projects:remove": [[path: string], void];
  "sessions:list": [[projectPath: string], SessionSummary[]];
  "sessions:load": [[ref: SessionRef, options?: { complete: boolean }], SessionLoadResult];
  "claude:subagents": [[sessionId: string, projectPath: string], string[]];
  "claude:subagentMessages": [[sessionId: string, projectPath: string, agentId: string], import("@zcode/shared/zcode-protocol-v4").ConversationRow[]];
  "codex:subagents": [[sessionId: string, projectPath: string], import("./types.js").NativeSubagent[]];
  "codex:subagentMessages": [[sessionId: string, projectPath: string, agentId: string], import("@zcode/shared/zcode-protocol-v4").ConversationRow[]];
  "agy:subagents": [[sessionId: string, projectPath: string], import("./types.js").NativeSubagent[]];
  "agy:subagentMessages": [[sessionId: string, projectPath: string, agentId: string], import("@zcode/shared/zcode-protocol-v4").ConversationRow[]];
  "sessions:search": [[query: string], SessionSearchResult[]];
  "sessions:rename": [[ref: SessionRef, title: string], void];
  /** 删除 / 归档成功后清理置顶记录，返回最新设置。 */
  "sessions:delete": [[ref: SessionRef], Settings];
  /** 分叉出新会话；回退到第一条消息之前时没有可保留的内容，返回 null。 */
  "sessions:fork": [[params: ForkParams], SessionSummary | null];
  "chat:send": [[params: ChatSendParams], { sessionKey: string }];
  "chat:interrupt": [[sessionKey: string], void];
  /** 投递到当前回合或确定无法投递后才返回；Claude 要等到下一个工具间隙。 */
  "chat:steer": [[params: ChatSteerParams], ChatSteerResult];
  "chat:stopBackgroundTask": [[sessionKey: string, taskId: string], void];
  "chat:setPermissionMode": [[sessionKey: string, mode: PermissionMode], void];
  "chat:setModel": [[sessionKey: string, model: string], void];
  "chat:close": [[sessionKey: string], void];
  "permission:respond": [[interactionId: string, decision: PermissionDecision], void];
  "git:branches": [[cwd: string], GitBranches | null];
  "git:graph": [[cwd: string, maxCount?: number, skip?: number], import("@zcode/shared").GitCommitGraphResult];
  "git:worktree": [[cwd: string], import("./types.js").GitWorktree | null];
  "git:diff": [[cwd: string, path: string], string];
  "git:commit": [[cwd: string, message: string, stageAll: boolean], void];
  "git:push": [[cwd: string], void];
  "git:switchBranch": [[cwd: string, branch: string], GitBranchSwitchResult];
  "git:branchSwitchPreview": [[cwd: string], GitBranchSwitchPreview];
  "git:commitAndSwitch": [[cwd: string, branch: string, message: string, preview: GitBranchSwitchPreview], GitCommitAndSwitchResult];
  "git:createBranch": [[cwd: string, name: string], void];
  /** 有界 UTF-8 文本读取（最多 2 MiB）；二进制、超限或读取失败返回 null。 */
  "fs:readText": [[path: string, maxBytes?: number], string | null];
  "fs:createHtmlPreview": [[path: string, workspacePath?: string], import("./htmlPreview.js").HtmlPreviewLease];
  "fs:releaseHtmlPreview": [[id: string], void];
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
  "settings:get": [[], Settings];
  "settings:set": [[patch: SettingsPatch], Settings];
  "remote:status": [[], import("./remoteControl.js").RemoteControlStatus];
  /** 远程访问口令；首次调用时生成。 */
  "remote:token": [[], string];
  /** 重新生成口令，所有已登录的远程客户端立即失效。 */
  "remote:regenerateToken": [[], string];
  /** 通知事件流的订阅令牌；首次调用时生成。 */
  "remote:notificationToken": [[], string];
  /** 重新生成订阅令牌，已有订阅立即断开。 */
  "remote:regenerateNotificationToken": [[], string];
}

/** 主进程 → 渲染进程事件 */
export interface EventMap {
  "memory:updated": void;
  "terminal:event": { id: string; data?: string; exitCode?: number };
  "agentInvocation:updated": import('./agentInvocation.js').AgentInvocation;
  "collaboration:codeDraftUpdated": CodeDraft;
  "collaboration:draftUpdated": ResearchDraft;
  "collaboration:expertDraftUpdated": ExpertDraft;
  "collaboration:updated": CollaborationSnapshot;
  "app:menuCommand": { command: AppCommand; index?: number; fromAccelerator?: boolean };
  "sessions:indexChanged": { projectPaths: string[] };
  "chat:rows": ChatRowsEvent;
  "chat:state": ChatStateEvent;
  "chat:commands": SlashCommandsEvent;
  "chat:promptSuggestion": import('./types.js').ChatPromptSuggestionEvent;
  "permission:requested": PermissionRequestEvent;
  "permission:resolved": PermissionResolvedEvent;
  "window:fullscreen": { fullscreen: boolean };
  "quota:updated": AgentQuota;
  "remote:status": import("./remoteControl.js").RemoteControlStatus;
}

export type InvokeChannel = keyof InvokeMap;
export type EventChannel = keyof EventMap;

export interface HCodeBridge {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeMap[C][0]): Promise<InvokeMap[C][1]>;
  on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void;
  platform: NodeJS.Platform;
  getPathForFile(file: File): string | null;
  /** 浏览器远程操控页面；本机窗口为 undefined。 */
  remote?: boolean;
}

export const INVOKE_CHANNELS: readonly InvokeChannel[] = [
  "system:battery",
  "memory:list", "memory:save", "memory:delete",
  "terminal:create", "terminal:write", "terminal:resize", "terminal:close",
  "agentInvocation:list", "agentInvocation:cancel",
  "collaboration:codeDraftCreate", "collaboration:codeDraftList", "collaboration:codeDraftUpdate", "collaboration:codeDraftPrepare", "collaboration:codeDraftConfirm", "collaboration:codeDraftCancel", "collaboration:codeDraftAbandon",
  "collaboration:expertDraftCreate", "collaboration:expertDraftList", "collaboration:expertDraftUpdate", "collaboration:expertDraftPrepare", "collaboration:expertDraftConfirm", "collaboration:expertDraftCancel", "collaboration:expertDraftAbandon",
  "collaboration:draftCreate", "collaboration:draftList", "collaboration:draftUpdate", "collaboration:draftPrepare", "collaboration:draftConfirm", "collaboration:draftCancel", "collaboration:draftAbandon",
  "collaboration:expertProfiles",
  "collaboration:presentation", "collaboration:adoptionPreview", "collaboration:applyCandidate", "collaboration:recoverAdoption", "collaboration:codeAdmission", "collaboration:candidatePreview", "collaboration:candidateAction", "collaboration:capabilities", "collaboration:start", "collaboration:startExperts", "collaboration:resumeExperts", "collaboration:get", "collaboration:list", "collaboration:cancel", "collaboration:artifact", "collaboration:pause", "collaboration:resume", "collaboration:reply", "collaboration:supplement", "collaboration:takeover", "collaboration:cancelDelivery", "collaboration:recoveryIssues", "collaboration:repair",
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
  "projects:addPath",
  "projects:browseDirectories",
  "projects:setPinned",
  "projects:reorder",
  "projects:remove",
  "sessions:list",
  "sessions:load",
  "claude:subagents",
  "claude:subagentMessages",
  "codex:subagents",
  "codex:subagentMessages",
  "agy:subagents",
  "agy:subagentMessages",
  "sessions:search",
  "sessions:rename",
  "sessions:delete",
  "sessions:fork",
  "chat:send",
  "chat:interrupt",
  "chat:steer",
  "chat:stopBackgroundTask",
  "chat:setPermissionMode",
  "chat:setModel",
  "chat:close",
  "permission:respond",
  "git:branches",
  "git:graph",
  "git:worktree",
  "git:diff",
  "git:commit",
  "git:push",
  "git:switchBranch",
  "git:branchSwitchPreview",
  "git:commitAndSwitch",
  "git:createBranch",
  "fs:readText",
  "fs:createHtmlPreview",
  "fs:releaseHtmlPreview",
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
  "settings:get",
  "settings:set",
  "remote:status",
  "remote:token",
  "remote:regenerateToken",
  "remote:notificationToken",
  "remote:regenerateNotificationToken",
];

export const EVENT_CHANNELS: readonly EventChannel[] = [
  "memory:updated",
  "terminal:event",
  "agentInvocation:updated",
  "collaboration:codeDraftUpdated",
  "collaboration:draftUpdated", "collaboration:expertDraftUpdated",
  "collaboration:updated",
  "app:menuCommand",
  "sessions:indexChanged",
  "chat:rows",
  "chat:state",
  "chat:commands",
  "chat:promptSuggestion",
  "permission:requested",
  "permission:resolved",
  "window:fullscreen",
  "quota:updated",
  "remote:status",
];
