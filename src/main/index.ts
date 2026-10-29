import { presentationForRun, presentationForDraft } from "../shared/collaborationPresentation.js";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentInvocationService } from './invocations/agentInvocationService.js';
import { InvocationRepository } from './invocations/invocationRepository.js';
import { MemoryRepository } from './memory/memoryRepository.js';
import { MemoryService } from './memory/memoryService.js';
import { mergeHosted } from './sessions/researchRuntime.js';
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, clipboard, dialog, ipcMain, net, powerMonitor, powerSaveBlocker, protocol, shell } from "electron";
import type { EventChannel, EventMap, InvokeChannel, InvokeMap } from "../shared/ipc.js";
import { AGENTS } from "../shared/agents.js";
import { BACKGROUND_IMAGE_EXTENSIONS, BACKGROUND_VIDEO_EXTENSIONS, getDefaultModel } from "../shared/types.js";
import type { ChatStateEvent } from "../shared/types.js";
import { getComputerBattery } from "./battery.js";
import { AppStore } from "./appStore.js";
import { ClaudeAgent } from "./agents/claude/claudeAgent.js";
import { listSubagents, getSubagentMessages } from "@anthropic-ai/claude-agent-sdk";
import { projectSubagentHistory, type ClaudeRecord } from "./agents/claude/rowProjector.js";
import { CodexAgent } from "./agents/codex/codexAgent.js";
import { AgyAgent } from "./agents/agy/agyAgent.js";
import { AgentRegistry } from "./agents/registry.js";
import type { AgentEvents } from "./agents/types.js";
import { branchSwitchPreview, commitAndSwitch, commitChanges, commitGraph, createBranch, listBranches, pushChanges, repositoryRoot, switchBranch, worktree, worktreeDiff } from "./git.js";
import { buildProjects } from "./projects.js";
import { ConversationWorkspace } from "./conversationWorkspace.js";
import { buildShellBootstrapPath, captureLoginShellEnvSnapshot } from "./util/loginShellEnv.js";
import { QuotaService } from "./quotaService.js";
import { createMainWindow } from "./window.js";
import { listProjectFiles } from "./projectFiles.js";
import { ExtensionsService } from "./extensions.js";
import { searchSessions } from "./sessionSearch.js";
import { installApplicationMenu } from "./menu.js";
import { readTextFile } from "./readTextFile.js";
import { HtmlPreviewService } from "./htmlPreview.js";
import { HTML_PREVIEW_SCHEME } from "../shared/htmlPreview.js";
import { SessionExecutionService } from "./sessions/sessionExecutionService.js";
import { OrdinaryContinuationService } from "./sessions/ordinaryContinuation.js";
import {ExpertProfileService} from "./collaboration/experts/profiles/expertProfileService.js";
import { CollaborationService } from "./collaboration/collaborationService.js";
import { CodeDraftService } from "./collaboration/drafts/codeDraftService.js";
import { ExpertDraftService } from "./collaboration/drafts/expertDraftService.js";
import { ResearchDraftService } from "./collaboration/drafts/researchDraftService.js";
import { CollaborationRepository } from "./collaboration/collaborationRepository.js";
import { TerminalService } from "./terminalService.js";
import { RemoteControlService } from "./remoteControl/remoteControlService.js";
import { remoteImageThumbnail } from "./remoteControl/imageThumbnail.js";
import { RemoteTokenStore } from "./remoteControl/tokenStore.js";
import { RemoteSessionStore } from "./remoteControl/sessionStore.js";
import { browseProjectDirectories, prepareProjectDirectory } from "./remoteControl/projectDirectory.js";

app.setName("HCode");
// 开发时 userData 与正式版分开（必须在申请单实例锁之前，否则会和正在运行的正式版冲突）
if (process.env.HCODE_DEV_SERVER_URL) {
  app.setPath("userData", join(app.getPath("appData"), "HCode-dev"));
}
if (!app.requestSingleInstanceLock()) app.quit();

// 背景图片/视频经此协议提供：视频需要 stream 才能按 Range 拖动播放。
protocol.registerSchemesAsPrivileged([
  { scheme: "hcode-media", privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  { scheme: HTML_PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let mainWindow: BrowserWindow | null = null;
let shellEnv: Record<string, string> = {};
let remote: RemoteControlService | null = null;
/** handle() 注册的全部 handler，远程操控按白名单复用。 */
const invokeHandlers = new Map<InvokeChannel, (...args: unknown[]) => unknown>();

function send<C extends EventChannel>(channel: C, payload: EventMap[C]) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  remote?.publish(channel, payload);
}

function handle<C extends InvokeChannel>(
  channel: C,
  handler: (...args: InvokeMap[C][0]) => InvokeMap[C][1] | Promise<InvokeMap[C][1]>,
) {
  invokeHandlers.set(channel, handler as (...args: unknown[]) => unknown);
  ipcMain.handle(channel, (_event, ...args) => handler(...(args as InvokeMap[C][0])));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildAgentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...shellEnv })) {
    if (typeof value === "string") env[key] = value;
  }
  env.PATH = buildShellBootstrapPath(env.PATH);
  // 不把 Electron 自身的调试变量传给 claude
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HCODE_DEV_SERVER_URL;
  return env;
}

async function bootstrap() {
  handle("system:battery", getComputerBattery);
  if (!app.isPackaged && process.platform === "darwin") {
    app.dock?.setIcon(join(app.getAppPath(), "resources", "icon.png"));
  }
  shellEnv = (await captureLoginShellEnvSnapshot()) ?? {};
  const store = new AppStore(app.getPath("userData"));
  const conversationWorkspace = new ConversationWorkspace(app.getPath("userData"));
  const memory = new MemoryService(new MemoryRepository(join(app.getPath('userData'), 'memories')), conversationWorkspace.path, () => send('memory:updated', undefined), () => store.settings.memoryEnabled);
  handle('memory:list', () => memory.list());
  handle('memory:save', entry => memory.save(entry));
  handle('memory:delete', id => memory.delete(id));
  const terminals = new TerminalService(event => send("terminal:event", event));
  handle("terminal:create", (id, cwd, cols, rows) => terminals.create(id, cwd, buildAgentEnv(), cols, rows));
  handle("terminal:write", (id, data) => terminals.write(id, data));
  handle("terminal:resize", (id, cols, rows) => terminals.resize(id, cols, rows));
  handle("terminal:close", id => terminals.close(id));
  let quota: QuotaService | null = null;
  let execution: SessionExecutionService | null = null;

  // 有会话在运行且开关打开时阻止系统休眠
  const runningSessions = new Set<string>();
  const activeGitSessions = new Set<string>();
  const sessionGitRoots = new Map<string, string>();
  const startingGitSessions = new Set<string>();
  const gitOperationRoots = new Set<string>();
  const withGitOperation = async <T>(cwd: string, operation: () => Promise<T>): Promise<T> => {
    const root = await repositoryRoot(cwd, buildAgentEnv());
    if (gitOperationRoots.has(root)) throw new Error("该仓库正在处理 Git 操作，请稍后重试");
    for (const [key, sessionRoot] of sessionGitRoots) {
      if (sessionRoot === root && (activeGitSessions.has(key) || startingGitSessions.has(key))) {
        throw new Error("该仓库有会话正在运行或等待审批，请结束后再操作 Git");
      }
    }
    gitOperationRoots.add(root);
    try { return await operation(); }
    finally { gitOperationRoots.delete(root); }
  };
  let sleepBlockerId: number | null = null;
  const syncSleepBlocker = () => {
    const shouldBlock = store.settings.preventSleepWhileRunning && runningSessions.size > 0;
    if (shouldBlock && sleepBlockerId === null) {
      sleepBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    } else if (!shouldBlock && sleepBlockerId !== null) {
      powerSaveBlocker.stop(sleepBlockerId);
      sleepBlockerId = null;
    }
  };

  const recentTurnStates = new Map<string, ChatStateEvent>();
  const events: AgentEvents = {
    turnOutcome: (event) => execution?.acceptOutcome(event),
    rows: (sessionKey, ops) => send("chat:rows", { sessionKey, ops }),
    state: (event) => {
      agents.observeState(event);
      if (event.sessionId) execution?.observeIdentity(event.sessionKey, event.agent, event.sessionId);
      if (event.state === "running" || event.backgroundTasks) runningSessions.add(event.sessionKey);
      else runningSessions.delete(event.sessionKey);
      if (event.state === "running" || event.state === "awaitingApproval") activeGitSessions.add(event.sessionKey);
      else activeGitSessions.delete(event.sessionKey);
      syncSleepBlocker();
      const previous = recentTurnStates.get(event.sessionKey);
      const enriched = { ...event, sessionId: event.sessionId ?? previous?.sessionId };
      recentTurnStates.set(event.sessionKey, enriched);
      send("chat:state", enriched);
    },
    commands: (sessionKey, commands) => send("chat:commands", { sessionKey, commands }),
    promptSuggestion: event => send('chat:promptSuggestion', event),
    permission: (event) => {
      send("permission:requested", event);
      if (mainWindow && !mainWindow.isFocused()) app.dock?.bounce("informational");
    },
    permissionResolved: (event) => send("permission:resolved", event),
    indexChanged: (projectPaths) => send("sessions:indexChanged", { projectPaths }),
    quotaStale: (agent) => quota?.markStale(agent),
  };
  const claude = new ClaudeAgent(events, buildAgentEnv, () => store.settings.agentPaths.claude,
    () => [...store.projects.manual, conversationWorkspace.path]);
  const codex = new CodexAgent(events, buildAgentEnv, () => store.settings.agentPaths.codex, app.getVersion());
  const agy = new AgyAgent(events, buildAgentEnv, () => store.settings.agentPaths.agy, join(app.getPath("userData"), "agy-collaboration"));
  const agents = new AgentRegistry({
    claude,
    codex,
    agy,
  }, (projectPaths) => send("sessions:indexChanged", { projectPaths }));
  quota = new QuotaService(agents, (snapshot) => send("quota:updated", snapshot));
  const extensions = new ExtensionsService(claude, codex, buildAgentEnv);
  const requireSession = (sessionKey: string) => {
    const provider = agents.bySessionKey(sessionKey);
    if (!provider) throw new Error("会话不存在或已关闭");
    return provider;
  };

  handle("agent:status", () => agents.statuses(true));
  handle("agent:models", (agent) => agents.get(agent).listModels());
  handle("agent:commands", (agent, projectPath, sessionKey, sessionId) =>
    agents.get(agent).listCommands?.(projectPath, sessionKey, sessionId) ?? Promise.resolve([]),
  );
  handle("extensions:list", (agent, projectPath) => extensions.list(agent, projectPath));
  handle("extensions:setMcpEnabled", (agent, projectPath, name, enabled) => extensions.setMcpEnabled(agent, projectPath, name, enabled));
  handle("extensions:addMcp", (params) => extensions.addMcp(params));
  handle("extensions:removeMcp", (agent, projectPath, name, scope) => extensions.removeMcp(agent, projectPath, name, scope));
  handle("extensions:setSkillEnabled", (agent, projectPath, path, name, enabled) => extensions.setSkillEnabled(agent, projectPath, path, name, enabled));
  handle("quota:list", (force) => quota!.list(force));

  handle("workspace:conversation", () => conversationWorkspace.ensure());
  handle("projects:list", async (refresh) => buildProjects(await agents.allSessions(refresh), store, conversationWorkspace.path));
  handle("projects:add", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "添加项目",
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    store.updateProjects((prefs) => ({
      ...prefs,
      manual: path === conversationWorkspace.path || prefs.manual.includes(path) ? prefs.manual : [path, ...prefs.manual],
    }));
    const projects = buildProjects(await agents.allSessions(), store, conversationWorkspace.path);
    return projects.find((project) => project.path === path) ?? null;
  });
  handle("projects:addPath", async (input, create) => {
    const path = await prepareProjectDirectory(input, create, conversationWorkspace.path);
    store.updateProjects((prefs) => ({ ...prefs, manual: prefs.manual.includes(path) ? prefs.manual : [path, ...prefs.manual] }));
    const project = buildProjects(await agents.allSessions(), store, conversationWorkspace.path).find((item) => item.path === path);
    if (!project) throw new Error("无法添加项目");
    send("sessions:indexChanged", { projectPaths: [path] });
    return project;
  });
  handle("projects:browseDirectories", (path, showHidden) => browseProjectDirectories(path, showHidden));
  handle("projects:setPinned", (path, pinned) => {
    if (path === conversationWorkspace.path) throw new Error("对话目录不支持项目置顶");
    store.updateProjects((prefs) => ({
      ...prefs,
      pinned: pinned ? [...new Set([...prefs.pinned, path])] : prefs.pinned.filter((p) => p !== path),
    }));
  });
  handle("projects:reorder", (paths) => {
    store.updateProjects((prefs) => ({
      ...prefs,
      manual: [...paths.filter((p) => p !== conversationWorkspace.path && prefs.manual.includes(p)), ...prefs.manual.filter((p) => p !== conversationWorkspace.path && !paths.includes(p))],
    }));
  });
  handle("projects:remove", (path) => {
    if (path === conversationWorkspace.path) throw new Error("对话目录由 HCode 管理，不能移除");
    store.updateProjects((prefs) => ({
      ...prefs,
      pinned: prefs.pinned.filter((p) => p !== path),
      manual: prefs.manual.filter((p) => p !== path),
    }));
  });

  handle("sessions:list", async (projectPath) =>
    (await agents.allSessions()).filter((session) => session.projectPath === projectPath),
  );
  handle("sessions:load", (ref) => agents.get(ref.agent).loadSession(ref.id, ref.projectPath));
  handle("claude:subagents", (sessionId, projectPath) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error("无效的 Claude 会话 ID");
    return listSubagents(sessionId, { dir: projectPath });
  });
  handle("claude:subagentMessages", async (sessionId, projectPath, agentId) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error("无效的 Claude 会话 ID");
    const ids = await listSubagents(sessionId, { dir: projectPath });
    if (!ids.includes(agentId)) throw new Error("子代理不属于当前会话");
    const messages = await getSubagentMessages(sessionId, agentId, { dir: projectPath });
    return projectSubagentHistory(messages as ClaudeRecord[]).snapshot();
  });
  handle("codex:subagents", (sessionId, projectPath) => codex.listSubagents(sessionId, projectPath));
  handle("codex:subagentMessages", (sessionId, projectPath, agentId) => codex.loadSubagent(sessionId, projectPath, agentId));
  handle("agy:subagents", (sessionId, projectPath) => agy.listSubagents(sessionId, projectPath));
  handle("agy:subagentMessages", (sessionId, projectPath, agentId) => agy.loadSubagent(sessionId, projectPath, agentId));
  let searchGeneration = 0;
  handle("sessions:search", (query) => {
    const generation = ++searchGeneration;
    return searchSessions(agents, query, () => generation !== searchGeneration);
  });
  handle("sessions:rename", (ref, title) => agents.get(ref.agent).renameSession(ref.id, ref.projectPath, title));
  handle("sessions:delete", async (ref) => {
    await agents.get(ref.agent).deleteSession(ref.id, ref.projectPath);
    agents.forgetSession(ref);
    return store.removeSessionPin(ref);
  });
  handle("sessions:fork", (params) => {
    const provider = agents.get(params.ref.agent);
    if (!provider.forkSession) throw new Error(`${AGENTS[params.ref.agent].name} 不支持分叉会话`);
    return provider.forkSession(params);
  });

  execution = new SessionExecutionService({
    ordinaryTools: (params, turnId, signal) => {
      if (params.agent !== 'claude' && params.agent !== 'codex') return undefined;
      return mergeHosted([
        store.settings.agentDelegation ? invocations.tools(params, turnId, signal) : undefined,
        store.settings.memoryEnabled ? memory.tools(params, signal) : undefined,
      ]);
    },
    ordinaryMemory: async params => store.settings.memoryEnabled && (params.agent === 'claude' || params.agent === 'codex') ? memory.snapshot(params) : undefined,
    ordinaryContinuation: (params): Promise<string | undefined> => continuation.forMessage(params),
    send: (params) => agents.send(params),
    interrupt: async (key) => { await requireSession(key).interrupt(key); },
    failedToSend: () => {},
    finishedSending: (key) => startingGitSessions.delete(key),
    prepare: async (params) => {
      if (params.projectPath === conversationWorkspace.path) await conversationWorkspace.ensure();
      const files = await Promise.all((params.files ?? []).map(async (file) => {
        if (!isAbsolute(file.path)) throw new Error(`附件路径无效：${file.name}`);
        const path = await realpath(file.path);
        const info = await stat(path);
        if (!info.isFile()) throw new Error(`附件不是文件：${file.name}`);
        return { path, name: file.name || basename(path), mimeType: file.mimeType || "application/octet-stream", size: info.size };
      }));
      const root = await repositoryRoot(params.projectPath, buildAgentEnv()).catch(() => null);
      if (root && gitOperationRoots.has(root)) throw new Error("该仓库正在处理 Git 操作，请完成后再发送消息");
      if (root) sessionGitRoots.set(params.sessionKey, root);
      startingGitSessions.add(params.sessionKey);
      return { ...params, files };
    },
  });
  handle("chat:send", (params) => execution!.send(params));
  const invocations = new AgentInvocationService(new InvocationRepository(join(app.getPath('userData'), 'agent-invocations')), execution, call => send('agentInvocation:updated', call), agent => getDefaultModel(store.settings, agent), agents);
  handle('agentInvocation:list', (key, nativeId) => invocations.list(key, nativeId));
  handle('agentInvocation:cancel', id => invocations.cancel(id));
  const collaborationRepository = new CollaborationRepository(join(app.getPath("userData"), "collaborations"));
  const collaboration = new CollaborationService(collaborationRepository, execution, agents, (snapshot) => send("collaboration:updated", snapshot), process.platform, new ExpertProfileService(join(app.getPath("userData"),"collaborations"),{discoverSkills:project=>extensions.expertSkills(project)}));
  const drafts = new ResearchDraftService(join(app.getPath("userData"), "collaboration-plans"), collaboration, execution, agents, draft => send("collaboration:draftUpdated", draft));
  const expertDrafts = new ExpertDraftService(join(app.getPath("userData"), "expert-plans"), collaboration, execution, agents, draft => send("collaboration:expertDraftUpdated", draft));
  const codeDrafts = new CodeDraftService(join(app.getPath("userData"), "code-plans"), collaboration, execution, agents, draft => send("collaboration:codeDraftUpdated", draft));
  const continuation: OrdinaryContinuationService = new OrdinaryContinuationService({
    runs: params => collaboration.list(params.sessionKey, params.resumeSessionId),
    drafts: async params => (await Promise.all([drafts.list(params.sessionKey, params.resumeSessionId), expertDrafts.list(params.sessionKey, params.resumeSessionId), codeDrafts.list(params.sessionKey, params.resumeSessionId)])).flat(),
  });
  handle("collaboration:presentation", async () => {
    const runs = await collaborationRepository.catalog();
    // 展示沿用服务的恢复和采纳状态；磁盘上的 running 不代表重启后仍在执行。
    const current = await Promise.allSettled(runs.snapshots.map(snapshot => collaboration.get(snapshot.id)));
    const result = await Promise.allSettled([
      drafts.repository.list().then(saved => Promise.all(saved.map(draft => drafts.get(draft.id)))),
      expertDrafts.repository.list().then(saved => Promise.all(saved.map(draft => expertDrafts.get(draft.id)))),
      codeDrafts.repository.list().then(saved => Promise.all(saved.map(draft => codeDrafts.get(draft.id)))),
    ]);
    const entries = current.flatMap(item => item.status === "fulfilled" ? [presentationForRun(item.value)] : []);
    const errors = [...runs.issues.map(issue => issue.error), ...current.flatMap((item, index) => item.status === "rejected" ? [`读取协作 ${runs.snapshots[index]!.id} 展示失败：${String(item.reason)}`] : [])];
    for (const item of result) {
      if (item.status === "fulfilled") entries.push(...item.value.map(presentationForDraft));
      else errors.push(`读取协作计划索引失败：${String(item.reason)}`);
    }
    return { entries, errors };
  });
  handle("collaboration:codeDraftCreate", input => codeDrafts.create(input));
  handle("collaboration:codeDraftList", (key, nativeId) => codeDrafts.list(key, nativeId));
  handle("collaboration:codeDraftUpdate", (id, revision, edit) => codeDrafts.update(id, revision, edit));
  handle("collaboration:codeDraftPrepare", (id, revision) => codeDrafts.prepare(id, revision));
  handle("collaboration:codeDraftConfirm", (id, revision) => codeDrafts.confirm(id, revision));
  handle("collaboration:codeDraftCancel", id => codeDrafts.cancel(id));
  handle("collaboration:codeDraftAbandon", (id, revision) => codeDrafts.abandon(id, revision));
  handle("collaboration:expertDraftCreate", input => expertDrafts.create(input));
  handle("collaboration:expertDraftList", (key, nativeId) => expertDrafts.list(key, nativeId));
  handle("collaboration:expertDraftUpdate", (id, revision, edit) => expertDrafts.update(id, revision, edit));
  handle("collaboration:expertDraftPrepare", (id, revision) => expertDrafts.prepare(id, revision));
  handle("collaboration:expertDraftConfirm", (id, revision) => expertDrafts.confirm(id, revision));
  handle("collaboration:expertDraftCancel", id => expertDrafts.cancel(id));
  handle("collaboration:expertDraftAbandon", (id, revision) => expertDrafts.abandon(id, revision));
  handle("collaboration:draftCreate", input => drafts.create(input));
  handle("collaboration:draftList", (key, nativeId) => drafts.list(key, nativeId));
  handle("collaboration:draftUpdate", (id, revision, edit) => drafts.update(id, revision, edit));
  handle("collaboration:draftPrepare", (id, revision) => drafts.prepare(id, revision));
  handle("collaboration:draftConfirm", (id, revision) => drafts.confirm(id, revision));
  handle("collaboration:draftCancel", id => drafts.cancel(id));
  handle("collaboration:draftAbandon", (id, revision) => drafts.abandon(id, revision));
  handle("collaboration:codeAdmission", (path) => collaboration.inspectCodeProject(path));
  handle("collaboration:candidatePreview", (id, version) => collaboration.candidatePreview(id, version));
  handle("collaboration:adoptionPreview", (id,version) => collaboration.adoptionPreview(id,version));
  handle("collaboration:applyCandidate", (id,request) => collaboration.applyCandidate(id,request));
  handle("collaboration:recoverAdoption", (id,adoptionId) => collaboration.recoverAdoption(id,adoptionId));
  handle("collaboration:candidateAction", (id, action, deliveryId) => collaboration.candidateAction(id, action, deliveryId));
  handle("collaboration:capabilities", (source) => collaboration.capabilities(source));
  handle("collaboration:start", (params) => collaboration.start(params));
  handle('collaboration:expertProfiles',project=>collaboration.profiles.catalog(project));
  handle('collaboration:startExperts',params=>collaboration.startExperts(params));
  handle('collaboration:resumeExperts',(id,params)=>collaboration.expertControls.resume(id,params));
  handle("collaboration:get", (id) => collaboration.get(id));
  handle("collaboration:list", (key, id) => collaboration.list(key, id));
  handle("collaboration:pause", (id) => collaboration.controls.stop(id, "pause"));
  handle("collaboration:resume", (id, params) => collaboration.controls.resume(id, params));
  handle("collaboration:reply", (id, messageId, text) => collaboration.controls.reply(id, messageId, text));
  handle("collaboration:supplement", (id, targetId, text) => collaboration.controls.supplement(id, targetId, text));
  handle("collaboration:takeover", (id) => collaboration.controls.takeover(id));
  handle("collaboration:cancelDelivery", (id, deliveryId) => collaboration.controls.cancelDelivery(id, deliveryId));
  handle("collaboration:recoveryIssues", () => collaboration.recoveryIssues());
  handle("collaboration:repair", (id) => collaboration.repair(id));
  handle("collaboration:cancel", (id) => collaboration.cancel(id));
  handle("collaboration:artifact", (runId, versionId) => collaboration.artifact(runId, versionId));
  handle("chat:interrupt", async (sessionKey) => {
    execution!.cancelSource(sessionKey);
    const runId = execution!.reservationOwner(sessionKey);
    if (runId && codeDrafts.isPlanning(runId)) return codeDrafts.cancel(runId);
    if (runId && expertDrafts.isPlanning(runId)) return expertDrafts.cancel(runId);
    if (runId && drafts.isPlanning(runId)) return drafts.cancel(runId);
    if (runId) return collaboration.cancel(runId);
    await agents.bySessionKey(sessionKey)?.interrupt(sessionKey);
  });
  handle("chat:setPermissionMode", async (sessionKey, mode) => { if (execution!.isReserved(sessionKey) || invocations.hasActiveSource(sessionKey)) throw new Error("请先暂停协作或停止 AI 调用再修改权限"); await requireSession(sessionKey).setPermissionMode(sessionKey, mode); execution!.updateSourcePermission(sessionKey, mode); });
  handle("chat:setModel", (sessionKey, model) => { if (execution!.isReserved(sessionKey)) throw new Error("请先暂停协作再修改模型"); return requireSession(sessionKey).setModel(sessionKey, model); });
  handle("chat:close", (sessionKey) => {
    if (execution!.isReserved(sessionKey)) return;
    recentTurnStates.delete(sessionKey);
    sessionGitRoots.delete(sessionKey);
    activeGitSessions.delete(sessionKey);
    return agents.bySessionKey(sessionKey)?.closeSession(sessionKey);
  });
  handle("permission:respond", (interactionId, decision) => agents.respondPermission(interactionId, decision));

  handle("git:branches", (cwd) => listBranches(cwd, buildAgentEnv()));
  handle("git:graph", (cwd, maxCount, skip) => commitGraph(cwd, buildAgentEnv(), maxCount, skip));
  handle("git:worktree", (cwd) => worktree(cwd, buildAgentEnv()));
  handle("git:diff", (cwd, path) => worktreeDiff(cwd, buildAgentEnv(), path));
  handle("git:commit", (cwd, message, stageAll) => withGitOperation(cwd, () => commitChanges(cwd, buildAgentEnv(), message, stageAll)));
  handle("git:push", (cwd) => withGitOperation(cwd, () => pushChanges(cwd, buildAgentEnv())));
  handle("git:switchBranch", (cwd, branch) => withGitOperation(cwd, () => switchBranch(cwd, buildAgentEnv(), branch)));
  handle("git:branchSwitchPreview", (cwd) => branchSwitchPreview(cwd, buildAgentEnv()));
  handle("git:commitAndSwitch", (cwd, branch, message, preview) => withGitOperation(cwd, () => commitAndSwitch(cwd, buildAgentEnv(), branch, message, preview)));
  handle("git:createBranch", (cwd, name) => withGitOperation(cwd, () => createBranch(cwd, buildAgentEnv(), name)));
  handle("fs:readText", readTextFile);
  const htmlPreview = new HtmlPreviewService();
  handle("fs:createHtmlPreview", (path, workspacePath) => htmlPreview.create(path, workspacePath));
  handle("fs:releaseHtmlPreview", id => htmlPreview.release(id));
  protocol.handle(HTML_PREVIEW_SCHEME, request => htmlPreview.respond(request));
  handle("fs:stat", async (path) => {
    try {
      const info = await stat(path);
      return { exists: true, isDirectory: info.isDirectory(), size: info.size };
    } catch {
      return null;
    }
  });
  handle("fs:listProjectFiles", (cwd, query) => listProjectFiles(cwd, query));
  handle("fs:readMedia", async (path) => {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 10 * 1024 * 1024) return null;
      return await readFile(path);
    } catch {
      return null;
    }
  });

  handle("app:pickAudio", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile"],
      filters: [{ name: "音频", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac", "aiff"] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle("app:pickBackground", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile"],
      filters: [
        { name: "图片或视频", extensions: [...BACKGROUND_IMAGE_EXTENSIONS, ...BACKGROUND_VIDEO_EXTENSIONS] },
      ],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  // 只提供设置里当前选中的背景文件，不接受渲染进程指定任意路径。
  protocol.handle("hcode-media", (request) => {
    const path = store.settings.background.path;
    if (new URL(request.url).host !== "background" || !path) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(path).toString(), { headers: request.headers });
  });
  handle("app:openPath", async (path) => {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  handle("app:showInFinder", (path) => shell.showItemInFolder(path));
  handle("app:openExternal", async (url) => {
    if (/^(https?|mailto):/i.test(url)) await shell.openExternal(url);
  });
  handle("app:openInTerminal", async (cwd, session) => {
    const resume = session ? await agents.get(session.agent).resumeCommand(session.id) : [];
    const command = [`cd ${shellQuote(cwd)}`, ...(resume.length ? [resume.map(shellQuote).join(" ")] : [])].join(" && ");
    await new Promise<void>((resolve) => {
      execFile(
        "osascript",
        [
          "-e",
          `tell application "Terminal" to do script ${appleScriptString(command)}`,
          "-e",
          'tell application "Terminal" to activate',
        ],
        () => resolve(),
      );
    });
  });
  handle("app:copyText", (text) => clipboard.writeText(text));
  handle("app:saveText", async (defaultName, text) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: join(app.getPath("downloads"), defaultName),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, text, "utf8");
    return result.filePath;
  });
  handle("app:focusWindow", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  handle("fs:stageAttachment", async ({ name, data }) => {
    // 剪贴板文件没有磁盘路径时，保存到持久目录供 CLI 和历史会话继续读取。
    if (data.length > 28 * 1024 * 1024) throw new Error("剪贴板附件超过 20MB");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > 20 * 1024 * 1024) throw new Error("剪贴板附件超过 20MB");
    const dir = join(app.getPath("userData"), "attachments");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${randomUUID()}-${basename(name.replaceAll("\\", "/")) || "attachment"}`);
    await writeFile(path, bytes, { flag: "wx" });
    return path;
  });

  const remoteTokens = new RemoteTokenStore(app.getPath("userData"));
  const remoteNotificationTokens = new RemoteTokenStore(app.getPath("userData"), "remote-notification-token");
  remote = new RemoteControlService({
    config: () => store.settings.remoteControl,
    tokens: remoteTokens,
    notificationTokens: remoteNotificationTokens,
    sessions: new RemoteSessionStore(app.getPath("userData")),
    policy: {
      projectPaths: () => [...store.projects.manual, conversationWorkspace.path],
      attachmentsDir: join(app.getPath("userData"), "attachments"),
      sessionState: (sessionKey) => remote?.sessionState(sessionKey),
    },
    invoke: async (channel, args) => {
      const handler = invokeHandlers.get(channel);
      if (!handler) throw new Error(`Unknown IPC channel: ${channel}`);
      return handler(...args);
    },
    liveRows: (sessionKey) => agents.liveRows(sessionKey),
    hasSession: (sessionKey) => agents.bySessionKey(sessionKey) !== undefined,
    sessionTitle: (state) => agents.sessionTitle(state),
    staticDir: join(app.getAppPath(), "out", "renderer"),
    thumbnail: remoteImageThumbnail,
    env: buildAgentEnv,
    onStatus: (status) => send("remote:status", status),
  });
  handle("remote:status", () => remote!.getStatus());
  handle("remote:token", () => remoteTokens.get());
  handle("remote:regenerateToken", () => remote!.regenerateToken());
  handle("remote:notificationToken", () => remoteNotificationTokens.get());
  handle("remote:regenerateNotificationToken", () => remote!.regenerateNotificationToken());

  handle("settings:get", () => store.settings);
  handle("settings:set", (patch) => {
    const settings = store.updateSettings(patch);
    syncSleepBlocker();
    if (patch.remoteControl) void remote?.apply();
    if (process.platform === "darwin" && patch.shortcuts) installApplicationMenu(() => mainWindow, settings.shortcuts);
    return settings;
  });

  agents.startWatching();
  void remote.apply();
  powerMonitor.on("resume", () => remote?.reconnect());
  if (process.platform === "darwin") installApplicationMenu(() => mainWindow, store.settings.shortcuts);
  const openMainWindow = () => {
    const window = createMainWindow(store);
    window.on("closed", () => terminals.dispose());
    window.webContents.on("render-process-gone", () => terminals.dispose());
    window.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame && !_inPlace) terminals.dispose();
    });
    return window;
  };
  mainWindow = openMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = openMainWindow();
    }
  });
  app.on("before-quit", () => {
    terminals.dispose();
    invocations.dispose(); execution?.dispose();
    drafts.dispose(); expertDrafts.dispose(); codeDrafts.dispose();
    collaboration.dispose();
    quota?.dispose();
    remote?.dispose();
    agents.dispose();
  });
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void app.whenReady().then(bootstrap);
