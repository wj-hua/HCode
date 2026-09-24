import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import type { EventChannel, EventMap, InvokeChannel, InvokeMap } from "../shared/ipc.js";
import { AppStore } from "./appStore.js";
import { ClaudeAgent } from "./agents/claude/claudeAgent.js";
import { CodexAgent } from "./agents/codex/codexAgent.js";
import { StepAgent } from "./agents/step/stepAgent.js";
import { AgyAgent } from "./agents/agy/agyAgent.js";
import { AgentRegistry } from "./agents/registry.js";
import type { AgentEvents } from "./agents/types.js";
import { listBranches, switchBranch } from "./git.js";
import { buildProjects } from "./projects.js";
import { buildShellBootstrapPath, captureLoginShellEnvSnapshot } from "./util/loginShellEnv.js";
import { createMainWindow } from "./window.js";

app.setName("HCode");
// 开发时 userData 与正式版分开（必须在申请单实例锁之前，否则会和正在运行的正式版冲突）
if (process.env.HCODE_DEV_SERVER_URL) {
  app.setPath("userData", join(app.getPath("appData"), "HCode-dev"));
}
if (!app.requestSingleInstanceLock()) app.quit();

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
  shellEnv = (await captureLoginShellEnvSnapshot()) ?? {};
  const store = new AppStore(app.getPath("userData"));

  const events: AgentEvents = {
    rows: (sessionKey, ops) => send("chat:rows", { sessionKey, ops }),
    state: (event) => send("chat:state", event),
    permission: (event) => {
      send("permission:requested", event);
      if (mainWindow && !mainWindow.isFocused()) app.dock?.bounce("informational");
    },
    permissionResolved: (event) => send("permission:resolved", event),
    indexChanged: (projectPaths) => send("sessions:indexChanged", { projectPaths }),
  };
  const agents = new AgentRegistry({
    claude: new ClaudeAgent(events, buildAgentEnv, () => store.settings.agentPaths.claude),
    codex: new CodexAgent(events, buildAgentEnv, () => store.settings.agentPaths.codex),
    step: new StepAgent(events, buildAgentEnv, () => store.settings.agentPaths.step),
    agy: new AgyAgent(events, buildAgentEnv, () => store.settings.agentPaths.agy),
  });
  const requireSession = (sessionKey: string) => {
    const provider = agents.bySessionKey(sessionKey);
    if (!provider) throw new Error("会话不存在或已关闭");
    return provider;
  };

  handle("agent:status", () => agents.statuses(true));
  handle("agent:models", (agent) => agents.get(agent).listModels());

  handle("projects:list", async () => buildProjects(await agents.allSessions(), store));
  handle("projects:add", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "添加项目",
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    store.updateProjects((prefs) => ({
      ...prefs,
      manual: prefs.manual.includes(path) ? prefs.manual : [...prefs.manual, path],
    }));
    const projects = buildProjects(await agents.allSessions(), store);
    return projects.find((project) => project.path === path) ?? null;
  });
  handle("projects:setPinned", (path, pinned) => {
    store.updateProjects((prefs) => ({
      ...prefs,
      pinned: pinned ? [...new Set([...prefs.pinned, path])] : prefs.pinned.filter((p) => p !== path),
    }));
  });
  handle("projects:remove", (path) => {
    store.updateProjects((prefs) => ({
      pinned: prefs.pinned.filter((p) => p !== path),
      manual: prefs.manual.filter((p) => p !== path),
    }));
  });

  handle("sessions:list", async (projectPath) =>
    (await agents.allSessions()).filter((session) => session.projectPath === projectPath),
  );
  handle("sessions:load", (ref) => agents.get(ref.agent).loadSession(ref.id, ref.projectPath));
  handle("sessions:rename", (ref, title) => agents.get(ref.agent).renameSession(ref.id, ref.projectPath, title));

  handle("chat:send", async (params) => {
    const files = await Promise.all((params.files ?? []).map(async (file) => {
      if (!isAbsolute(file.path)) throw new Error(`附件路径无效：${file.name}`);
      const path = await realpath(file.path);
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`附件不是文件：${file.name}`);
      return { path, name: file.name || basename(path), mimeType: file.mimeType || "application/octet-stream", size: info.size };
    }));
    return agents.send({ ...params, files });
  });
  handle("chat:interrupt", async (sessionKey) => {
    await agents.bySessionKey(sessionKey)?.interrupt(sessionKey);
  });
  handle("chat:setPermissionMode", (sessionKey, mode) => requireSession(sessionKey).setPermissionMode(sessionKey, mode));
  handle("chat:setModel", (sessionKey, model) => requireSession(sessionKey).setModel(sessionKey, model));
  handle("chat:close", (sessionKey) => agents.bySessionKey(sessionKey)?.closeSession(sessionKey));
  handle("permission:respond", (interactionId, decision) => agents.respondPermission(interactionId, decision));

  handle("git:branches", (cwd) => listBranches(cwd, buildAgentEnv()));
  handle("git:switchBranch", (cwd, branch) => switchBranch(cwd, buildAgentEnv(), branch));

  handle("fs:readText", async (path, maxBytes = 2 * 1024 * 1024) => {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > maxBytes) return null;
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  });
  handle("fs:stat", async (path) => {
    try {
      const info = await stat(path);
      return { exists: true, isDirectory: info.isDirectory(), size: info.size };
    } catch {
      return null;
    }
  });

  handle("app:openPath", async (path) => {
    await shell.openPath(path);
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

  handle("settings:get", () => store.settings);
  handle("settings:set", (patch) => store.updateSettings(patch));

  agents.startWatching();
  mainWindow = createMainWindow(store);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow(store);
  });
  app.on("before-quit", () => agents.dispose());
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
