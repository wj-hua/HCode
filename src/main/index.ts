import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, clipboard, dialog, ipcMain, net, powerSaveBlocker, protocol, shell } from "electron";
import type { EventChannel, EventMap, InvokeChannel, InvokeMap } from "../shared/ipc.js";
import { AGENTS } from "../shared/agents.js";
import { BACKGROUND_IMAGE_EXTENSIONS, BACKGROUND_VIDEO_EXTENSIONS } from "../shared/types.js";
import { AppStore } from "./appStore.js";
import { ClaudeAgent } from "./agents/claude/claudeAgent.js";
import { CodexAgent } from "./agents/codex/codexAgent.js";
import { PI_VARIANT } from "./agents/pi/piAgent.js";
import { StepAgent } from "./agents/step/stepAgent.js";
import { AgyAgent } from "./agents/agy/agyAgent.js";
import { AgentRegistry } from "./agents/registry.js";
import type { AgentEvents } from "./agents/types.js";
import { beginGitTurn, commitFiles, createBranch, finishGitTurn, isGitRepository, listBranches, previewGitTurn, repositoryRoot, revertFile, switchBranch, validateTurnFiles, type GitTurnSnapshot } from "./git.js";
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

app.setName("HCode");
// 开发时 userData 与正式版分开（必须在申请单实例锁之前，否则会和正在运行的正式版冲突）
if (process.env.HCODE_DEV_SERVER_URL) {
  app.setPath("userData", join(app.getPath("appData"), "HCode-dev"));
}
if (!app.requestSingleInstanceLock()) app.quit();

// 背景图片/视频经此协议提供：视频需要 stream 才能按 Range 拖动播放。
protocol.registerSchemesAsPrivileged([{ scheme: "hcode-media", privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);

let mainWindow: BrowserWindow | null = null;
let shellEnv: Record<string, string> = {};

function send<C extends EventChannel>(channel: C, payload: EventMap[C]) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function handle<C extends InvokeChannel>(
  channel: C,
  handler: (...args: InvokeMap[C][0]) => InvokeMap[C][1] | Promise<InvokeMap[C][1]>,
) {
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
  if (!app.isPackaged && process.platform === "darwin") {
    app.dock?.setIcon(join(app.getAppPath(), "resources", "icon.png"));
  }
  shellEnv = (await captureLoginShellEnvSnapshot()) ?? {};
  const store = new AppStore(app.getPath("userData"));
  const conversationWorkspace = new ConversationWorkspace(app.getPath("userData"));
  let quota: QuotaService | null = null;

  // 有会话在运行且开关打开时阻止系统休眠
  const runningSessions = new Set<string>();
  const activeGitTurns = new Set<string>();
  const gitTurns = new Map<string, GitTurnSnapshot>();
  const completedGitTurns = new Map<string, GitTurnSnapshot>();
  const sessionGitRoots = new Map<string, string>();
  const startingGitSessions = new Set<string>();
  const gitOperationRoots = new Set<string>();
  const pendingGitFinishes = new Map<string, { root: string; promise: Promise<void> }>();
  const turnGenerations = new Map<string, number>();
  const finishTurn = (sessionKey: string) => {
    const turn = gitTurns.get(sessionKey);
    if (!turn) return;
    gitTurns.delete(sessionKey);
    const generation = turnGenerations.get(sessionKey);
    const promise = finishGitTurn(turn).then(
      (diff) => {
        if (!turnGenerations.has(sessionKey)) return;
        if (turnGenerations.get(sessionKey) === generation) completedGitTurns.set(sessionKey, turn);
        send("git:turnDiff", { sessionKey, diff });
      },
      (error) => {
        if (!turnGenerations.has(sessionKey)) return;
        if (turnGenerations.get(sessionKey) === generation) completedGitTurns.set(sessionKey, turn);
        send("git:turnDiff", { sessionKey, turnId: turn.id, diff: { files: [], error: error instanceof Error ? error.message : String(error) } });
      },
    ).finally(() => {
      if (pendingGitFinishes.get(sessionKey)?.promise === promise) pendingGitFinishes.delete(sessionKey);
    });
    pendingGitFinishes.set(sessionKey, { root: turn.root, promise });
  };
  const withGitOperation = async (cwd: string, operation: () => Promise<void>) => {
    const root = await repositoryRoot(cwd, buildAgentEnv());
    if (gitOperationRoots.has(root)) throw new Error("该仓库正在处理 Git 操作，请稍后重试");
    if ([...pendingGitFinishes.values()].some((pending) => pending.root === root)) throw new Error("正在记录该仓库的本轮改动，请稍后重试");
    for (const [key, sessionRoot] of sessionGitRoots) {
      if (sessionRoot === root && (activeGitTurns.has(key) || startingGitSessions.has(key))) {
        throw new Error("该仓库有会话正在运行或等待审批，请结束后再操作 Git");
      }
    }
    gitOperationRoots.add(root);
    try { await operation(); }
    finally { gitOperationRoots.delete(root); }
  };
  const requireGitTurn = (sessionKey: string) => {
    const turn = completedGitTurns.get(sessionKey);
    if (!turn) throw new Error("本轮改动记录不存在，请先完成一轮对话");
    return turn;
  };
  const refreshGitTurn = async (sessionKey: string, turn: GitTurnSnapshot) => {
    const diff = await finishGitTurn(turn);
    if (completedGitTurns.get(sessionKey) === turn) send("git:turnDiff", { sessionKey, diff });
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

  const events: AgentEvents = {
    rows: (sessionKey, ops) => send("chat:rows", { sessionKey, ops }),
    state: (event) => {
      const wasActive = activeGitTurns.has(event.sessionKey);
      if (event.state === "running") runningSessions.add(event.sessionKey);
      else runningSessions.delete(event.sessionKey);
      if (event.state === "running" || event.state === "awaitingApproval") activeGitTurns.add(event.sessionKey);
      else activeGitTurns.delete(event.sessionKey);
      if (wasActive && (event.state === "idle" || event.state === "error")) {
        finishTurn(event.sessionKey);
        const { inputTokens = 0, outputTokens = 0 } = event.usage ?? {};
        if (inputTokens + outputTokens > 0) store.recordUsage(event.agent, event.model || "未知模型", inputTokens, outputTokens);
      }
      syncSleepBlocker();
      send("chat:state", event);
    },
    commands: (sessionKey, commands) => send("chat:commands", { sessionKey, commands }),
    permission: (event) => {
      send("permission:requested", event);
      if (mainWindow && !mainWindow.isFocused()) app.dock?.bounce("informational");
    },
    permissionResolved: (event) => send("permission:resolved", event),
    indexChanged: (projectPaths) => send("sessions:indexChanged", { projectPaths }),
    quotaStale: (agent) => quota?.markStale(agent),
  };
  const claude = new ClaudeAgent(events, buildAgentEnv, () => store.settings.agentPaths.claude);
  const codex = new CodexAgent(events, buildAgentEnv, () => store.settings.agentPaths.codex, app.getVersion());
  const agents = new AgentRegistry({
    claude,
    codex,
    step: new StepAgent(events, buildAgentEnv, () => store.settings.agentPaths.step),
    agy: new AgyAgent(events, buildAgentEnv, () => store.settings.agentPaths.agy),
    pi: new StepAgent(events, buildAgentEnv, () => store.settings.agentPaths.pi, PI_VARIANT),
  });
  quota = new QuotaService(agents, buildAgentEnv, (snapshot) => send("quota:updated", snapshot));
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
  handle("projects:list", async () => buildProjects(await agents.allSessions(), store, conversationWorkspace.path));
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
  let searchGeneration = 0;
  handle("sessions:search", (query) => {
    const generation = ++searchGeneration;
    return searchSessions(agents, query, () => generation !== searchGeneration);
  });
  handle("sessions:rename", (ref, title) => agents.get(ref.agent).renameSession(ref.id, ref.projectPath, title));
  handle("sessions:delete", async (ref) => {
    await agents.get(ref.agent).deleteSession(ref.id, ref.projectPath);
    return store.removeSessionPin(ref);
  });
  handle("sessions:fork", (params) => {
    const provider = agents.get(params.ref.agent);
    if (!provider.forkSession) throw new Error(`${AGENTS[params.ref.agent].name} 不支持分叉会话`);
    return provider.forkSession(params);
  });

  handle("chat:send", async (params) => {
    if (params.projectPath === conversationWorkspace.path) await conversationWorkspace.ensure();
    const files = await Promise.all((params.files ?? []).map(async (file) => {
      if (!isAbsolute(file.path)) throw new Error(`附件路径无效：${file.name}`);
      const path = await realpath(file.path);
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`附件不是文件：${file.name}`);
      return { path, name: file.name || basename(path), mimeType: file.mimeType || "application/octet-stream", size: info.size };
    }));
    const root = await repositoryRoot(params.projectPath, buildAgentEnv()).catch(() => null);
    // 排队发送前先完成上一轮的读取，避免把下一轮的写入算进上一轮历史。
    await Promise.all([...pendingGitFinishes.values()].filter((pending) => pending.root === root).map((pending) => pending.promise));
    if (root && gitOperationRoots.has(root)) throw new Error("该仓库正在处理 Git 操作，请完成后再发送消息");
    if (root) sessionGitRoots.set(params.sessionKey, root);
    startingGitSessions.add(params.sessionKey);
    try {
      // 在 CLI 有机会修改文件前记录基线；Git 不可用时仍照常发送消息。
      const turn = await beginGitTurn(params.projectPath, buildAgentEnv(), params.text).catch(() => null);
      turnGenerations.set(params.sessionKey, (turnGenerations.get(params.sessionKey) ?? 0) + 1);
      completedGitTurns.delete(params.sessionKey);
      if (turn) {
        gitTurns.set(params.sessionKey, turn);
        send("git:turnDiff", { sessionKey: params.sessionKey, diff: null, turnId: turn.id });
      }
      return await agents.send({ ...params, files });
    } catch (error) {
      finishTurn(params.sessionKey);
      throw error;
    } finally {
      startingGitSessions.delete(params.sessionKey);
    }
  });
  handle("chat:interrupt", async (sessionKey) => {
    await agents.bySessionKey(sessionKey)?.interrupt(sessionKey);
  });
  handle("chat:setPermissionMode", (sessionKey, mode) => requireSession(sessionKey).setPermissionMode(sessionKey, mode));
  handle("chat:setModel", (sessionKey, model) => requireSession(sessionKey).setModel(sessionKey, model));
  handle("chat:close", (sessionKey) => {
    gitTurns.delete(sessionKey);
    completedGitTurns.delete(sessionKey);
    sessionGitRoots.delete(sessionKey);
    turnGenerations.delete(sessionKey);
    activeGitTurns.delete(sessionKey);
    return agents.bySessionKey(sessionKey)?.closeSession(sessionKey);
  });
  handle("permission:respond", (interactionId, decision) => agents.respondPermission(interactionId, decision));

  handle("git:branches", (cwd) => listBranches(cwd, buildAgentEnv()));
  handle("git:switchBranch", (cwd, branch) => withGitOperation(cwd, () => switchBranch(cwd, buildAgentEnv(), branch)));
  handle("git:isRepository", (cwd) => isGitRepository(cwd, buildAgentEnv()));
  handle("git:createBranch", (cwd, name) => withGitOperation(cwd, () => createBranch(cwd, buildAgentEnv(), name)));
  handle("git:previewTurn", (cwd, record) => previewGitTurn(cwd, buildAgentEnv(), record));
  handle("git:refreshTurnDiff", (sessionKey) => {
    const turn = requireGitTurn(sessionKey);
    return withGitOperation(turn.root, () => refreshGitTurn(sessionKey, turn));
  });
  handle("git:commit", (sessionKey, files, message) => {
    const turn = requireGitTurn(sessionKey);
    return withGitOperation(turn.root, async () => {
      await validateTurnFiles(turn, files);
      await commitFiles(turn.root, buildAgentEnv(), files, message);
      for (const path of files) turn.handled.add(path);
      await refreshGitTurn(sessionKey, turn);
    });
  });
  handle("git:revertFile", (sessionKey, file) => {
    const turn = requireGitTurn(sessionKey);
    return withGitOperation(turn.root, async () => {
      await revertFile(turn, file);
      await refreshGitTurn(sessionKey, turn);
    });
  });

  handle("fs:readText", readTextFile);
  handle("fs:stat", async (path) => {
    try {
      const info = await stat(path);
      return { exists: true, isDirectory: info.isDirectory(), size: info.size };
    } catch {
      return null;
    }
  });
  handle("fs:listProjectFiles", (cwd, query) => listProjectFiles(cwd, query));
  handle("fs:readAudio", async (path) => {
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

  handle("usage:get", () => store.readUsage());
  handle("usage:clear", () => store.clearUsage());
  handle("settings:get", () => store.settings);
  handle("settings:set", (patch) => {
    const settings = store.updateSettings(patch);
    syncSleepBlocker();
    return settings;
  });

  agents.startWatching();
  if (process.platform === "darwin") installApplicationMenu(() => mainWindow);
  mainWindow = createMainWindow(store);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow(store);
  });
  app.on("before-quit", () => {
    quota?.dispose();
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
