// Antigravity CLI（agy）接入：
// - 历史：~/.gemini/antigravity-cli/brain/<会话>/.system_generated/logs/transcript_full.jsonl（每行一个 step）；
//   会话的工作区只记在 sqlite 里（conversation_summaries.db 的 workspace_uris，或 conversations/<会话>.db 的
//   trajectory_metadata_blob），用 Node 自带的 node:sqlite 只读打开；没有工作区的会话无法归到项目，不列出。
// - 标题：HCode 手动重命名 > agy CLI 改名（annotations/<会话>.pbtxt 与摘要库不同）> 第一条用户消息 > agy 自动标题。
// - 实时会话：每个 HCode 会话一个 `agy -p --input-format stream-json` 进程，见 agySession.ts。
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { AGENTS } from "../../../shared/agents.js";
import type {
  AgentQuota,
  AgentStatus,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  SessionLoadResult,
  SessionSummary,
  SlashCommandOption,
} from "../../../shared/types.js";
import { probeCli } from "../../util/locateCli.js";
import { trashPaths } from "../../util/trash.js";
import { agyQuota, quotaError } from "../quota.js";
import { isRecord } from "../rowProjectorBase.js";
import type { AgentEvents, AgentProvider, AgentSendParams } from "../types.js";
import { skillName } from "../../util/skillFrontmatter.js";
import { projectAgyHistory, projectAgySubagentHistory, userInputTitleText, type AgyStep } from "./agyProjector.js";
import { agyHistorySubagents, filterAgySubagentSessions, isAgyConversationId } from "./agySubagents.js";
import type { NativeSubagent } from "../../../shared/types.js";
import { GEMINI_MODEL_PREFIX } from "./agyResearchSession.js";
import { agyContextUsage, agyContextWindowTokens, groupAgyModels, resolveAgyModelInput } from "../../../shared/agyModels.js";
import { AGY_DATA_DIR, agyHistoryContext, transcriptPath } from "./agyThinkingTranscript.js";
import { AgySession, type AgyLaunch } from "./agySession.js";

const execFileAsync = promisify(execFile);

const BRAIN_DIR = join(AGY_DATA_DIR, "brain");
const ANNOTATIONS_DIR = join(AGY_DATA_DIR, "annotations");
const SUMMARIES_DB = join(AGY_DATA_DIR, "conversation_summaries.db");
const SETTINGS_PATH = join(AGY_DATA_DIR, "settings.json");

interface AgySettingsSnapshot {
  model?: string;
  contextWindow?: Record<string, string>;
}

async function readAgySettings(): Promise<AgySettingsSnapshot> {
  try {
    const raw = (await readFile(SETTINGS_PATH, "utf8")).replace(/^\uFEFF/, "");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : undefined;
    let contextWindow: Record<string, string> | undefined;
    if (isRecord(parsed.contextWindow)) {
      const entries = Object.entries(parsed.contextWindow).filter((entry): entry is [string, string] => typeof entry[1] === "string");
      if (entries.length > 0) {
        contextWindow = Object.fromEntries(entries.map(([key, value]) => [key.trim().toLowerCase(), value]));
      }
    }
    return { ...(model ? { model } : {}), ...(contextWindow ? { contextWindow } : {}) };
  } catch {
    return {};
  }
}

async function readSteps(id: string): Promise<AgyStep[]> {
  const text = await readFile(transcriptPath(id), "utf8");
  const steps: AgyStep[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const step: unknown = JSON.parse(line);
      if (isRecord(step) && typeof step.type === "string") steps.push(step as AgyStep);
    } catch {
      // 写到一半的行
    }
  }
  return steps;
}

function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

function workspaceFromUris(value: unknown): string | undefined {
  try {
    const uris: unknown = typeof value === "string" && value ? JSON.parse(value) : null;
    const first = Array.isArray(uris) ? uris.find((uri) => typeof uri === "string" && uri.startsWith("file://")) : undefined;
    return first ? fileURLToPath(first as string) : undefined;
  } catch {
    return undefined;
  }
}

/** 从 protobuf 字节里找第一个 file:// 字符串（前面是 1~2 字节的 varint 长度）。 */
function workspaceFromBlob(blob: Uint8Array): string | undefined {
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let at = buf.indexOf("file://"); at >= 2; at = buf.indexOf("file://", at + 1)) {
    const lengths = [buf[at - 1]!, (buf[at - 2]! & 0x7f) | (buf[at - 1]! << 7)];
    if (buf[at - 2]! >= 0x80) lengths.reverse();
    for (const length of lengths) {
      if (buf[at - 1]! >= 0x80 || at + length > buf.length) continue;
      const uri = buf.subarray(at, at + length).toString("utf8");
      if (/^file:\/\/\/[^\x00-\x1f�]*$/.test(uri)) {
        try {
          return fileURLToPath(uri);
        } catch {
          // 不是合法的 file URL，继续找
        }
      }
    }
  }
  return undefined;
}

function conversationWorkspace(id: string): string | undefined {
  try {
    const db = openReadOnly(join(AGY_DATA_DIR, "conversations", `${id}.db`));
    try {
      const row = db.prepare("SELECT data FROM trajectory_metadata_blob LIMIT 1").get();
      return row?.data instanceof Uint8Array ? workspaceFromBlob(row.data) : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

async function annotationTitle(id: string): Promise<string> {
  const text = await readFile(join(ANNOTATIONS_DIR, `${id}.pbtxt`), "utf8").catch(() => "");
  const match = /^title:\s*"((?:[^"\\]|\\.)*)"/m.exec(text);
  return match ? match[1]!.replace(/\\(.)/g, "$1") : "";
}

/** 读文件开头找第一条用户输入（去掉图片上传说明与附件清单）。 */
async function firstUserText(id: string): Promise<string> {
  const handle = await open(transcriptPath(id), "r").catch(() => null);
  if (!handle) return "";
  try {
    const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(256 * 1024), position: 0 });
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      try {
        const step: unknown = JSON.parse(line);
        if (isRecord(step) && step.type === "USER_INPUT" && typeof step.content === "string") {
          return userInputTitleText(step.content);
        }
      } catch {
        // 被截断的最后一行
      }
    }
    return "";
  } finally {
    await handle.close();
  }
}

interface SummaryRow {
  title: string;
  workspace?: string;
}

function readSummaryDb(): Map<string, SummaryRow> {
  const rows = new Map<string, SummaryRow>();
  try {
    const db = openReadOnly(SUMMARIES_DB);
    try {
      for (const row of db.prepare("SELECT conversation_id, title, workspace_uris FROM conversation_summaries").all()) {
        const workspace = workspaceFromUris(row.workspace_uris);
        rows.set(String(row.conversation_id), {
          title: typeof row.title === "string" ? row.title : "",
          ...(workspace ? { workspace } : {}),
        });
      }
    } finally {
      db.close();
    }
  } catch {
    // 没用过 agy 或库结构变了
  }
  return rows;
}

function clip(title: string): string {
  const line = title.trim().split("\n")[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/**
 * 解析 agy 会话标题：
 * 1. HCode 手动重命名；
 * 2. agy CLI 手动改名（agy 会把自动英文标题同时写进 annotations 和摘要库，两者都有值且不同时才视为 CLI 改名）；
 * 3. 第一条用户消息原文（保留中文）；
 * 4. 兜底回退到 agy 自动标题（如首条仅含图片/附件）。
 */
export function resolveAgySessionTitle(sources: {
  customTitle?: string;
  annotationTitle?: string;
  summaryTitle?: string;
  firstUserText?: string;
}): string {
  const custom = sources.customTitle?.trim();
  if (custom) return clip(custom);
  const ann = sources.annotationTitle?.trim() ?? "";
  const summary = sources.summaryTitle?.trim() ?? "";
  const cliRenamed = ann && summary && ann !== summary ? ann : "";
  const raw = cliRenamed || sources.firstUserText?.trim() || ann || summary;
  return clip(raw) || "未命名会话";
}

function readCustomTitles(path: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!path) return map;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return map;
    for (const [id, title] of Object.entries(parsed)) {
      if (typeof title === "string" && title.trim()) map.set(id, title.trim());
    }
  } catch {
    // 尚未重命名过 agy 会话
  }
  return map;
}

function writeCustomTitles(path: string | undefined, titles: ReadonlyMap<string, string>) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(titles), null, 2));
  renameSync(tmp, path);
}

export class AgyAgent implements AgentProvider {
  readonly kind = "agy" as const;
  private readonly sessions = new Map<string, AgySession>();
  private status: AgentStatus | null = null;
  private models: ModelOption[] | null = null;
  private rawModelIds = new Set<string>();
  private modelVariants = new Map<string, Map<string, string>>();
  /** 会话 id → 工作区（不会变，找到后一直缓存；没找到的按 transcript 的 mtime 重试）。 */
  private readonly workspaces = new Map<string, { workspace?: string; mtimeMs: number }>();
  /** 会话 id → 首条用户消息（非空后一直缓存；空值在 transcript 变更时重试）。 */
  private readonly firstPrompts = new Map<string, { text: string; mtimeMs: number }>();
  private readonly customTitles: Map<string, string>;
  private readonly childIndex = new Map<string, { mtimeMs: number; size: number; children: NativeSubagent[] }>();
  private cache: SessionSummary[] | null = null;
  private loading: Promise<SessionSummary[]> | null = null;
  private generation = 0;
  private watchers: FSWatcher[] = [];
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly events: AgentEvents,
    private readonly getEnv: () => Record<string, string>,
    private readonly getPathOverride: () => string,
    private readonly researchRoot: string,
    private readonly customTitlesPath?: string,
  ) {
    this.customTitles = readCustomTitles(customTitlesPath);
  }

  async getStatus(refresh = false): Promise<AgentStatus> {
    if (!this.status || refresh) this.status = await probeCli("agy", "agy", this.getEnv(), this.getPathOverride());
    return this.status;
  }

  private async resolveLaunch(cwd: string, args: string[]): Promise<AgyLaunch> {
    const status = await this.getStatus();
    if (!status.found || !status.path) throw new Error("未找到 agy 命令，请在设置中指定路径");
    return { path: status.path, env: this.getEnv(), cwd, args };
  }

  /**
   * `/` 补全：agy 没有列出命令的接口，这里扫描 `.agents/skills/<名称>/SKILL.md`（用户目录和项目目录，
   * 同名时项目优先），无头模式下 `/<名称>` 会展开为该技能。插件技能和 skills.json 里自定义的路径不在其中。
   */
  async listCommands(projectPath: string): Promise<SlashCommandOption[]> {
    const commands = new Map<string, SlashCommandOption>();
    for (const root of [join(homedir(), ".agents", "skills"), join(projectPath, ".agents", "skills")]) {
      const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const dir of dirs) {
        if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
        const content = await readFile(join(root, dir.name, "SKILL.md"), "utf8").catch(() => null);
        if (content === null) continue;
        const { name, description } = skillName(content.slice(0, 8192), dir.name);
        commands.set(name, { name, description, argumentHint: "任务描述" });
      }
    }
    return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** `agy models` 每行是 “id<TAB>名称”，按基础模型折叠并附上思考强度档位。 */
  async listModels(): Promise<ModelOption[]> {
    if (this.models) return this.models;
    const { path, env } = await this.resolveLaunch(AGY_DATA_DIR, []);
    const { stdout } = await execFileAsync(path, ["models"], { env, timeout: 30_000 });
    const raw = stdout.split("\n").filter((line) => line.trim()).map((line) => {
      const parts = line.split("\t");
      if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim()) throw new Error("agy 模型列表格式无效，不能使用静态列表替代");
      return { value: parts[0]!.trim(), label: parts[1]!.trim() };
    });
    if (!raw.length) throw new Error("agy 没有返回当前账号的模型列表");
    const grouped = groupAgyModels(raw, AGENTS.agy.models[0]!);
    this.rawModelIds = grouped.rawIds;
    this.modelVariants = grouped.variants;
    this.models = grouped.models;
    return this.models;
  }

  /** `agy -p /quota` 是本地斜杠命令：不调用模型、不新建会话，stdout 的 command.data 里是按组的额度桶。 */
  async getQuota(): Promise<AgentQuota> {
    try {
      const { path, env } = await this.resolveLaunch(homedir(), []);
      const { stdout } = await execFileAsync(path, ["-p", "/quota", "--output-format", "json"], {
        env,
        cwd: homedir(),
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
      });
      return agyQuota(stdout);
    } catch (error) {
      // 非 0 退出时 stdout 里可能仍有带错误说明的 JSON
      const stdout = isRecord(error) && typeof error.stdout === "string" ? error.stdout : "";
      if (stdout.trim()) return agyQuota(stdout);
      if (isRecord(error)) {
        if (error.killed === true) return quotaError("agy", "读取额度超时（30 秒），请稍后重试");
        const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
        if (stderr) return quotaError("agy", stderr.slice(-500));
        if (typeof error.code === "number") return quotaError("agy", `agy 额度查询失败（退出码 ${error.code}）`);
      }
      return quotaError("agy", error);
    }
  }

  // ───────────────────────── 历史 ─────────────────────────

  async listSessions(refresh = false): Promise<SessionSummary[]> {
    if (refresh) { this.generation++; this.cache = null; this.loading = null; }
    if (this.cache) return this.cache;
    if (!this.loading) {
      const generation = this.generation;
      this.loading = this.scanSessions()
        .then((list) => {
          if (generation === this.generation) this.cache = list;
          return list;
        })
        .catch((error: unknown) => { if (refresh) throw error; return [] as SessionSummary[]; })
        .finally(() => {
          if (generation === this.generation) this.loading = null;
        });
    }
    return this.loading;
  }

  private async scanSessions(): Promise<SessionSummary[]> {
    const ids = await readdir(BRAIN_DIR).catch(() => [] as string[]);
    const summaries = readSummaryDb();
    const list: (SessionSummary | null)[] = [];
    // 分批读取首条消息，避免会话数量较多时并发打开过多文件；命中缓存后不再读盘。
    for (let offset = 0; offset < ids.length; offset += 20) {
      const batch = await Promise.all(ids.slice(offset, offset + 20).map((id) => this.summaryOf(id, summaries.get(id))));
      list.push(...batch);
    }
    const childIds = new Set<string>();
    // 限制同时读取的 transcript 数量，已扫描且未改变的文件直接复用结果。
    for (let offset = 0; offset < ids.length; offset += 20) {
      const groups = await Promise.all(ids.slice(offset, offset + 20).filter(isAgyConversationId).map(id => this.historySubagents(id)));
      for (const group of groups) for (const child of group) childIds.add(child.id);
    }
    for (const session of this.sessions.values()) {
      for (const child of session.nativeSubagents.values()) childIds.add(child.id);
    }
    const existing = new Set(ids);
    for (const id of this.childIndex.keys()) if (!existing.has(id)) this.childIndex.delete(id);
    for (const id of this.firstPrompts.keys()) if (!existing.has(id)) this.firstPrompts.delete(id);
    const valid = list.filter((item): item is SessionSummary => item !== null);
    return filterAgySubagentSessions(valid, childIds).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async historySubagents(id: string): Promise<NativeSubagent[]> {
    const info = await stat(transcriptPath(id)).catch(() => null);
    if (!info) return [];
    const cached = this.childIndex.get(id);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.children;
    try {
      const children = agyHistorySubagents(id, await readSteps(id));
      this.childIndex.set(id, { mtimeMs: info.mtimeMs, size: info.size, children });
      return children;
    } catch {
      // 读取失败时保留上次已确认的关联，下次扫描重试。
      return cached?.children ?? [];
    }
  }

  private async firstPrompt(id: string, mtimeMs: number): Promise<string> {
    const cached = this.firstPrompts.get(id);
    if (cached && (cached.text || cached.mtimeMs === mtimeMs)) return cached.text;
    const text = await firstUserText(id);
    this.firstPrompts.set(id, { text, mtimeMs });
    return text;
  }

  private async summaryOf(id: string, row: SummaryRow | undefined): Promise<SessionSummary | null> {
    const info = await stat(transcriptPath(id)).catch(() => null);
    if (!info) return null;
    let cached = this.workspaces.get(id);
    if (!cached || (!cached.workspace && cached.mtimeMs !== info.mtimeMs)) {
      const workspace = row?.workspace ?? conversationWorkspace(id);
      cached = { ...(workspace ? { workspace } : {}), mtimeMs: info.mtimeMs };
      this.workspaces.set(id, cached);
    }
    if (!cached.workspace) return null;
    const customTitle = this.customTitles.get(id);
    let title: string;
    if (customTitle) {
      title = resolveAgySessionTitle({ customTitle });
    } else {
      const ann = await annotationTitle(id);
      const summaryTitle = row?.title ?? "";
      const prompt = ann && summaryTitle && ann !== summaryTitle ? "" : await this.firstPrompt(id, info.mtimeMs);
      title = resolveAgySessionTitle({ annotationTitle: ann, summaryTitle, firstUserText: prompt });
    }
    return {
      id,
      agent: "agy",
      projectPath: cached.workspace,
      title,
      createdAt: info.birthtimeMs || info.mtimeMs,
      updatedAt: info.mtimeMs,
    };
  }

  async loadSession(id: string, _projectPath: string): Promise<SessionLoadResult> {
    const [steps, sessions, settings] = await Promise.all([
      readSteps(id),
      this.listSessions(),
      readAgySettings(),
    ]);
    const summary = sessions.find((item) => item.id === id) ?? null;
    const history = agyHistoryContext(steps);
    const windowTokens = agyContextWindowTokens(history.model ?? settings.model, settings.contextWindow);
    const usage = agyContextUsage(history.usedTokens, windowTokens);
    return {
      summary,
      rows: projectAgyHistory(steps).snapshot(),
      ...(usage ? { usage } : {}),
      ...(history.model ? { model: history.model } : {}),
    };
  }

  async listSubagents(id: string, projectPath: string): Promise<NativeSubagent[]> {
    if (!isAgyConversationId(id)) throw new Error("无效的 Antigravity 会话 ID");
    const active = [...this.sessions.values()].find(session => session.sessionId === id);
    const workspace = active?.projectPath ?? (await this.listSessions()).find(session => session.id === id)?.projectPath;
    const matches = workspace === projectPath || Boolean(workspace && await Promise.all([realpath(workspace), realpath(projectPath)])
      .then(([actual, requested]) => actual === requested).catch(() => false));
    if (!matches) throw new Error("Antigravity 会话与当前工作目录不匹配");
    const found = new Map<string, NativeSubagent>();
    const queue = [id];
    const visited = new Set<string>();
    while (queue.length) {
      const parent = queue.shift()!;
      if (visited.has(parent)) continue;
      if (visited.size >= 500) throw new Error("Antigravity 子代理数量过多，无法完整读取");
      visited.add(parent);
      const live = parent === id && active ? [...active.nativeSubagents.values()] : [];
      for (const child of [...await this.historySubagents(parent), ...live]) {
        if (child.id === id || visited.has(child.id)) continue;
        found.set(child.id, child);
        queue.push(child.id);
      }
    }
    return [...found.values()];
  }

  async loadSubagent(id: string, projectPath: string, childId: string) {
    if (!isAgyConversationId(childId)) throw new Error("无效的 Antigravity 子代理 ID");
    const children = await this.listSubagents(id, projectPath);
    if (!children.some(child => child.id === childId)) throw new Error("子代理不属于当前 Antigravity 会话");
    try { return projectAgySubagentHistory(await readSteps(childId)).snapshot(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** agy 的标题存在 annotations/<id>.pbtxt（/resume 里改名写这里）；摘要库与 HCode 重命名记录一并更新。 */
  async renameSession(id: string, projectPath: string, title: string): Promise<void> {
    const clean = title.replace(/[\r\n]+/g, " ").trim();
    const line = `title:"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const path = join(ANNOTATIONS_DIR, `${id}.pbtxt`);
    const current = await readFile(path, "utf8").catch(() => "");
    const next = /^title:.*$/m.test(current) ? current.replace(/^title:.*$/m, line) : `${line}\n${current}`;
    await writeFile(path, next);
    if (clean) this.customTitles.set(id, clean);
    else this.customTitles.delete(id);
    writeCustomTitles(this.customTitlesPath, this.customTitles);
    try {
      const db = new DatabaseSync(SUMMARIES_DB);
      try {
        db.prepare("UPDATE conversation_summaries SET title = ? WHERE conversation_id = ?").run(clean, id);
      } finally {
        db.close();
      }
    } catch {
      // 摘要库只是 agy 的缓存，更新失败不影响
    }
    this.invalidate([projectPath]);
  }

  /** 会话目录、会话库、标题都移到废纸篓；摘要库只是 agy 的缓存，直接删掉对应记录。 */
  async deleteSession(id: string, projectPath: string): Promise<void> {
    const db = join(AGY_DATA_DIR, "conversations", `${id}.db`);
    const moved = await trashPaths([
      join(BRAIN_DIR, id),
      db,
      `${db}-wal`,
      `${db}-shm`,
      join(ANNOTATIONS_DIR, `${id}.pbtxt`),
    ]);
    if (moved === 0) throw new Error("找不到这个 Antigravity 会话文件");
    try {
      const summaries = new DatabaseSync(SUMMARIES_DB);
      try {
        summaries.prepare("DELETE FROM conversation_summaries WHERE conversation_id = ?").run(id);
      } finally {
        summaries.close();
      }
    } catch {
      // 摘要库不存在或结构变了
    }
    this.workspaces.delete(id);
    this.firstPrompts.delete(id);
    if (this.customTitles.delete(id)) writeCustomTitles(this.customTitlesPath, this.customTitles);
    this.invalidate([projectPath]);
  }

  async resumeCommand(sessionId: string): Promise<string[]> {
    const status = await this.getStatus();
    return [status.path ?? "agy", "--conversation", sessionId];
  }

  private invalidate(projectPaths: string[] = []) {
    this.generation++;
    this.cache = null;
    this.loading = null;
    this.events.indexChanged(projectPaths);
  }

  startWatching() {
    if (this.watchers.length > 0) return;
    const onChange = (filename: string | null, suffix: string) => {
      if (filename && !filename.endsWith(suffix)) return;
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.invalidate(), 800);
    };
    try {
      this.watchers.push(watch(BRAIN_DIR, { recursive: true }, (_event, name) => onChange(name, "transcript_full.jsonl")));
      this.watchers.push(watch(ANNOTATIONS_DIR, (_event, name) => onChange(name, ".pbtxt")));
    } catch {
      // 没用过 agy 时目录不存在
    }
  }

  // ───────────────────────── 实时会话 ─────────────────────────

  hasSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  liveRows(sessionKey: string) {
    return this.sessions.get(sessionKey)?.liveRows();
  }

  async send(params: AgentSendParams): Promise<{ sessionKey: string }> {
    if (params.research) {
      const models = await this.listModels();
      const valid = params.model?.startsWith(GEMINI_MODEL_PREFIX) &&
        (models.some((model) => model.value === params.model) || this.rawModelIds.has(params.model));
      if (!valid) throw new Error("请选择 agy 返回的可用 Gemini 模型，不自动替换模型");
    }
    const resolved = resolveAgyModelInput(this.modelVariants, params.model, params.effort);
    let session = this.sessions.get(params.sessionKey);
    if (!session) {
      const settings = await readAgySettings();
      session = new AgySession(
        {
          resolveLaunch: (cwd, args) => this.resolveLaunch(cwd, args),
          emitRows: (key, ops) => this.events.rows(key, ops),
          emitState: (event) => this.events.state(event),
          emitPermission: (event) => this.events.permission(event),
          emitPermissionResolved: (event) => this.events.permissionResolved(event),
          emitTurnOutcome: (event) => this.events.turnOutcome?.(event),
          onSubagentsChanged: (session) => this.invalidate([session.projectPath]),
          onSettled: (done) => {
            this.invalidate([done.projectPath]);
            this.events.quotaStale("agy");
          },
        },
        {
          key: params.sessionKey,
          projectPath: params.projectPath,
          ...(params.resumeSessionId ? { sessionId: params.resumeSessionId } : {}),
          permissionMode: params.permissionMode,
          ...(params.research ? { research: params.research, researchRoot: this.researchRoot } : {}),
          transport: params.research ? "stream-json" : "acp",
          ...(resolved.model ? { model: resolved.model } : {}),
          ...(resolved.effort ? { effort: resolved.effort } : {}),
          ...(settings.model ? { defaultModel: settings.model } : {}),
          ...(settings.contextWindow ? { contextWindowOverrides: settings.contextWindow } : {}),
        },
      );
      this.sessions.set(session.key, session);
      if (params.resumeSessionId) session.seedHistory(await readSteps(params.resumeSessionId).catch(() => []));
      session.emitState();
    } else {
      session.configureResearch(params.research);
      if (session.permissionMode !== params.permissionMode) await session.setPermissionMode(params.permissionMode);
      if (session.model !== resolved.model) await session.setModel(resolved.model ?? "");
      if (session.effort !== resolved.effort) await session.setEffort(resolved.effort ?? "");
    }
    void session.send(params.text, params.images, params.files, params.executionTurnId);
    return { sessionKey: session.key };
  }

  private require(sessionKey: string): AgySession {
    const session = this.sessions.get(sessionKey);
    if (!session) throw new Error("会话不存在或已关闭");
    return session;
  }

  async interrupt(sessionKey: string) {
    await this.sessions.get(sessionKey)?.interrupt();
  }

  setPermissionMode(sessionKey: string, mode: PermissionMode) {
    return this.require(sessionKey).setPermissionMode(mode);
  }

  setModel(sessionKey: string, model: string) {
    return this.require(sessionKey).setModel(model);
  }

  closeSession(sessionKey: string) {
    const session = this.sessions.get(sessionKey);
    if (!session || session.isBusy || session.hasBackgroundTasks) return;
    session.close();
    this.sessions.delete(sessionKey);
  }

  /** ACP 会话支持交互式权限审批；无头研究会话不会发出此类请求。 */
  respondPermission(interactionId: string, decision: PermissionDecision): boolean {
    for (const session of this.sessions.values()) {
      if (session.ownsInteraction(interactionId)) {
        return session.respondPermission(interactionId, decision);
      }
    }
    return false;
  }

  dispose() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}
