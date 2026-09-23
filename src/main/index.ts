import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import type { EventChannel, EventMap, InvokeChannel, InvokeMap } from "../shared/ipc.js";
import { AppStore } from "./appStore.js";
import { ClaudeAgent } from "./agents/claude/claudeAgent.js";
import { buildProjects } from "./projects.js";
import { buildShellBootstrapPath, captureLoginShellEnvSnapshot } from "./util/loginShellEnv.js";
import { createMainWindow } from "./window.js";

app.setName("HCode");
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

  const claude = new ClaudeAgent(
    {
      rows: (sessionKey, ops) => send("chat:rows", { sessionKey, ops }),
      state: (event) => send("chat:state", event),
      permission: (event) => {
        send("permission:requested", event);
        if (mainWindow && !mainWindow.isFocused()) app.dock?.bounce("informational");
      },
      permissionResolved: (event) => send("permission:resolved", event),
      indexChanged: (projectPaths) => send("sessions:indexChanged", { projectPaths }),
    },
    buildAgentEnv,
    () => store.settings.claudePath,
  );

  handle("agent:status", () => claude.getStatus(true));

  handle("projects:list", async () => buildProjects(await claude.history.all(), store));
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
      removed: prefs.removed.filter((item) => item !== path),
    }));
    const projects = buildProjects(await claude.history.all(), store);
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
      removed: [...new Set([...prefs.removed, path])],
    }));
  });

  handle("sessions:list", (projectPath) => claude.history.list(projectPath));
  handle("sessions:load", (sessionId, projectPath) => claude.history.load(sessionId, projectPath));
  handle("sessions:rename", (sessionId, projectPath, title) =>
    claude.history.rename(sessionId, projectPath, title),
  );

  handle("chat:send", (params) => claude.send(params));
  handle("chat:interrupt", async (sessionKey) => {
    await claude.interrupt(sessionKey);
  });
  handle("chat:setPermissionMode", (sessionKey, mode) => claude.setPermissionMode(sessionKey, mode));
  handle("chat:setModel", (sessionKey, model) => claude.setModel(sessionKey, model));
  handle("chat:close", (sessionKey) => claude.closeSession(sessionKey));
  handle("permission:respond", (interactionId, decision) =>
    claude.respondPermission(interactionId, decision),
  );

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
  handle("app:openInTerminal", async (cwd, sessionId) => {
    const status = await claude.getStatus();
    const command = sessionId
      ? `cd ${shellQuote(cwd)} && ${shellQuote(status.path ?? "claude")} --resume ${shellQuote(sessionId)}`
      : `cd ${shellQuote(cwd)}`;
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

  handle("settings:get", () => store.settings);
  handle("settings:set", (patch) => store.updateSettings(patch));

  claude.history.startWatching();
  mainWindow = createMainWindow(store);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow(store);
  });
  app.on("before-quit", () => claude.dispose());
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

// 开发时 userData 与正式版分开
if (process.env.HCODE_DEV_SERVER_URL) {
  app.setPath("userData", join(app.getPath("appData"), "HCode-dev"));
}
