// HCode 自己的少量持久化数据：设置、用户手动添加/置顶/移除的项目。对话内容不在这里。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types.js";

interface ProjectPrefs {
  pinned: string[];
  manual: string[];
  removed: string[];
}

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(path, "utf8")) as T) };
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

/** 合并默认值，并把 v1（只有 claude）的扁平设置迁移到按 CLI 分组的新结构。 */
function migrateSettings(raw: Record<string, unknown>): Settings {
  const pick = <T extends object>(value: unknown, fallback: T): T =>
    value && typeof value === "object" ? { ...fallback, ...(value as Partial<T>) } : { ...fallback };
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...(raw as Partial<Settings>),
    agentPaths: pick(raw.agentPaths, DEFAULT_SETTINGS.agentPaths),
    defaultPermissionModes: pick(raw.defaultPermissionModes, DEFAULT_SETTINGS.defaultPermissionModes),
    defaultModels: pick(raw.defaultModels, DEFAULT_SETTINGS.defaultModels),
  };
  if (typeof raw.claudePath === "string" && raw.claudePath) settings.agentPaths.claude = raw.claudePath;
  if (typeof raw.defaultPermissionMode === "string") {
    settings.defaultPermissionModes.claude = raw.defaultPermissionMode;
  }
  if (typeof raw.defaultModel === "string") settings.defaultModels.claude = raw.defaultModel;
  for (const key of ["claudePath", "defaultPermissionMode", "defaultModel"]) {
    delete (settings as unknown as Record<string, unknown>)[key];
  }
  return settings;
}

export class AppStore {
  private readonly settingsPath: string;
  private readonly projectsPath: string;
  private readonly windowPath: string;
  settings: Settings;
  projects: ProjectPrefs;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.settingsPath = join(dataDir, "settings.json");
    this.projectsPath = join(dataDir, "projects.json");
    this.windowPath = join(dataDir, "window.json");
    this.settings = migrateSettings(readJson<Record<string, unknown>>(this.settingsPath, {}));
    this.projects = readJson<ProjectPrefs>(this.projectsPath, { pinned: [], manual: [], removed: [] });
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...patch };
    writeJson(this.settingsPath, this.settings);
    return this.settings;
  }

  updateProjects(update: (prefs: ProjectPrefs) => ProjectPrefs) {
    this.projects = update(this.projects);
    writeJson(this.projectsPath, this.projects);
  }

  readWindowState(): WindowState {
    return readJson<WindowState>(this.windowPath, { width: 1280, height: 820 });
  }

  writeWindowState(state: WindowState) {
    writeJson(this.windowPath, state);
  }
}
