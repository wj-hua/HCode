// 远程客户端能调用的通道及参数校验。校验在主进程完成，不依赖远程界面隐藏入口。
import { resolve, sep } from "node:path";
import type { EventChannel, InvokeChannel, InvokeMap } from "../../shared/ipc.js";
import { AGENTS } from "../../shared/agents.js";
import { DEFAULT_SETTINGS, type AgentKind, type PermissionMode, type Settings } from "../../shared/types.js";

export interface RemotePolicyContext {
  /** 已添加的项目和非项目对话目录。 */
  projectPaths(): string[];
  /** fs:stageAttachment 的保存目录；远程发送的附件只能来自这里。 */
  attachmentsDir: string;
  /** 活动会话的 CLI 与当前权限模式。 */
  sessionState(sessionKey: string): { agent: AgentKind; permissionMode: PermissionMode } | undefined;
}

type Guard<C extends InvokeChannel> = (context: RemotePolicyContext, ...args: InvokeMap[C][0]) => void;

function requireProject(context: RemotePolicyContext, path: string) {
  if (!context.projectPaths().includes(path)) throw new Error("远程只能访问已添加的项目");
}

const allow = () => {};

const GUARDS: { [C in InvokeChannel]?: Guard<C> } = {
  "system:battery": allow,
  "agent:status": allow,
  "agent:models": allow,
  "agent:commands": (context, _agent, projectPath) => requireProject(context, projectPath),
  "quota:list": allow,
  "projects:list": allow,
  "projects:addPath": allow,
  "projects:browseDirectories": allow,
  "workspace:conversation": allow,
  "git:branches": (context, cwd) => requireProject(context, cwd),
  "git:graph": (context, cwd) => requireProject(context, cwd),
  "git:switchBranch": (context, cwd) => requireProject(context, cwd),
  "git:branchSwitchPreview": (context, cwd) => requireProject(context, cwd),
  "git:commitAndSwitch": (context, cwd) => requireProject(context, cwd),
  "git:createBranch": (context, cwd) => requireProject(context, cwd),
  "sessions:list": (context, projectPath) => requireProject(context, projectPath),
  "sessions:load": (context, ref) => requireProject(context, ref.projectPath),
  "sessions:search": allow,
  "claude:subagents": (context, _id, projectPath) => requireProject(context, projectPath),
  "claude:subagentMessages": (context, _id, projectPath) => requireProject(context, projectPath),
  "codex:subagents": (context, _id, projectPath) => requireProject(context, projectPath),
  "codex:subagentMessages": (context, _id, projectPath) => requireProject(context, projectPath),
  "agy:subagents": (context, _id, projectPath) => requireProject(context, projectPath),
  "agy:subagentMessages": (context, _id, projectPath) => requireProject(context, projectPath),
  "chat:send": (context, params) => {
    requireProject(context, params.projectPath);
    const root = resolve(context.attachmentsDir) + sep;
    if (params.files?.some((file) => !resolve(file.path).startsWith(root))) throw new Error("远程附件需要先上传");
  },
  "chat:interrupt": allow,
  "chat:setPermissionMode": (context, sessionKey, mode) => {
    const current = context.sessionState(sessionKey);
    if (!current) throw new Error("会话不存在或已关闭");
    if (!AGENTS[current.agent].permissionModes.some((option) => option.mode === mode)) throw new Error("无效的权限模式");
  },
  "chat:setModel": allow,
  "permission:respond": allow,
  "fs:listProjectFiles": (context, cwd) => requireProject(context, cwd),
  "fs:stageAttachment": allow,
  "settings:get": allow,
};

export function checkRemoteInvoke(context: RemotePolicyContext, channel: string, args: unknown[]): channel is InvokeChannel {
  const guard = GUARDS[channel as InvokeChannel] as ((context: RemotePolicyContext, ...args: unknown[]) => void) | undefined;
  if (!guard) return false;
  guard(context, ...args);
  return true;
}

/** 远程看到的设置：保持完整结构，去掉本机路径和远程操控配置；浏览器里不发系统通知。 */
export function remoteSettings(settings: Settings): Settings {
  return {
    ...settings,
    notifyOnFinish: false,
    agentPaths: DEFAULT_SETTINGS.agentPaths,
    customSounds: DEFAULT_SETTINGS.customSounds,
    background: DEFAULT_SETTINGS.background,
    remoteControl: DEFAULT_SETTINGS.remoteControl,
  };
}

export const REMOTE_EVENTS: ReadonlySet<EventChannel> = new Set<EventChannel>([
  "chat:rows",
  "chat:state",
  "chat:commands",
  "chat:promptSuggestion",
  "permission:requested",
  "permission:resolved",
  "sessions:indexChanged",
  "quota:updated",
]);
