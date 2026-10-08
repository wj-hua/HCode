// HCode 自己的少量持久化数据：设置、用户手动添加/置顶的项目。对话内容不在这里。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, normalizeInterfaceMode, type AgentKind, type SessionSummary, type Settings, type SettingsPatch, type UsageStats } from "../shared/types.js";
import { sessionPinKey } from "../shared/sessionPins.js";

interface ProjectPrefs {
  pinned: string[];
  /** 项目列表的顺序即此数组顺序（侧边栏可拖动调整）。 */
  manual: string[];
  /** 旧版本按活动时间自动排序；为 false/缺省时首次加载会按活动时间初始化一次手动顺序。 */
  ordered?: boolean;
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
    interfaceMode: normalizeInterfaceMode(raw.interfaceMode),
    agentPaths: pick(raw.agentPaths, DEFAULT_SETTINGS.agentPaths),
    defaultPermissionModes: pick(raw.defaultPermissionModes, DEFAULT_SETTINGS.defaultPermissionModes),
    defaultModels: pick(raw.defaultModels, DEFAULT_SETTINGS.defaultModels),
    defaultEfforts: pick(raw.defaultEfforts, DEFAULT_SETTINGS.defaultEfforts),
    customSounds: pick(raw.customSounds, DEFAULT_SETTINGS.customSounds),
    background: pick(raw.background, DEFAULT_SETTINGS.background),
  };
  // 旧版内置语音已移除，沿用用户选择内置语音的意图。
  if (raw.notificationSound === "xiaoyi" || raw.notificationSound === "xiaoxiao") {
    settings.notificationSound = "xiao";
  }
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

/** 用补丁中有值的字段覆盖 base（undefined 视为未提供）。 */
function mergeDefined<T extends object>(base: T, patch: Partial<T> | undefined): T {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

/** 按 CLI 分组的字段逐项合并，只改补丁里给出的 CLI。 */
export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  const { agentPaths, defaultPermissionModes, defaultModels, defaultEfforts, ...rest } = patch;
  return {
    ...mergeDefined(current, rest),
    interfaceMode: patch.interfaceMode === undefined ? current.interfaceMode : normalizeInterfaceMode(patch.interfaceMode),
    agentPaths: mergeDefined(current.agentPaths, agentPaths),
    defaultPermissionModes: mergeDefined(current.defaultPermissionModes, defaultPermissionModes),
    defaultModels: mergeDefined(current.defaultModels, defaultModels),
    defaultEfforts: mergeDefined(current.defaultEfforts, defaultEfforts),
  };
}

export class AppStore {
  private readonly settingsPath: string;
  private readonly projectsPath: string;
  private readonly windowPath: string;
  private readonly usagePath: string;
  settings: Settings;
  projects: ProjectPrefs;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.settingsPath = join(dataDir, "settings.json");
    this.projectsPath = join(dataDir, "projects.json");
    this.windowPath = join(dataDir, "window.json");
    this.usagePath = join(dataDir, "usage.json");
    this.settings = migrateSettings(readJson<Record<string, unknown>>(this.settingsPath, {}));
    this.projects = readJson<ProjectPrefs>(this.projectsPath, { pinned: [], manual: [] });
  }

  updateSettings(patch: SettingsPatch): Settings {
    this.settings = mergeSettings(this.settings, patch);
    writeJson(this.settingsPath, this.settings);
    return this.settings;
  }

  updateProjects(update: (prefs: ProjectPrefs) => ProjectPrefs) {
    this.projects = update(this.projects);
    writeJson(this.projectsPath, this.projects);
  }

  removeSessionPin(session: Pick<SessionSummary, "agent" | "id">): Settings {
    const key = sessionPinKey(session);
    if (!this.settings.pinnedSessions.includes(key)) return this.settings;
    return this.updateSettings({ pinnedSessions: this.settings.pinnedSessions.filter((item) => item !== key) });
  }

  readUsage(): UsageStats {
    return readJson<UsageStats>(this.usagePath, {});
  }

  /** 把一轮对话的 Token 累加到今天（本地日期）× CLI × 模型。 */
  recordUsage(agent: AgentKind, model: string, input: number, output: number, now = new Date()) {
    const stats = this.readUsage();
    const day = (stats[now.toLocaleDateString("en-CA")] ??= {});
    const bucket = ((day[agent] ??= {})[model] ??= { input: 0, output: 0, turns: 0 });
    bucket.input += input;
    bucket.output += output;
    bucket.turns += 1;
    writeJson(this.usagePath, stats);
  }

  clearUsage() {
    writeJson(this.usagePath, {});
  }

  readWindowState(): WindowState {
    return readJson<WindowState>(this.windowPath, { width: 1280, height: 820 });
  }

  writeWindowState(state: WindowState) {
    writeJson(this.windowPath, state);
  }
}
