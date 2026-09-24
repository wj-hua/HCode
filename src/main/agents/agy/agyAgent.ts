// Antigravity CLI（agy）接入：
// - 历史：~/.gemini/antigravity-cli/brain/<会话>/.system_generated/logs/transcript_full.jsonl（每行一个 step）；
//   会话的工作区只记在 sqlite 里（conversation_summaries.db 的 workspace_uris，或 conversations/<会话>.db 的
//   trajectory_metadata_blob），用 Node 自带的 node:sqlite 只读打开；没有工作区的会话无法归到项目，不列出。
// - 标题：annotations/<会话>.pbtxt 的 title（agy 改名写这里）> 摘要库 title > 第一条用户消息。
// - 实时会话：每个 HCode 会话一个 `agy -p --input-format stream-json` 进程，见 agySession.ts。
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { AGENTS } from "../../../shared/agents.js";
import type {
  AgentQuota,
  AgentStatus,
  ChatSendParams,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  SessionLoadResult,
  SessionSummary,
} from "../../../shared/types.js";
import { probeCli } from "../../util/locateCli.js";
import { agyQuota, quotaError } from "../quota.js";
import { isRecord } from "../rowProjectorBase.js";
import type { AgentEvents, AgentProvider } from "../types.js";
import { projectAgyHistory, userRequestText, type AgyStep } from "./agyProjector.js";
import { AGY_DATA_DIR, AgySession, type AgyLaunch } from "./agySession.js";

const execFileAsync = promisify(execFile);

const BRAIN_DIR = join(AGY_DATA_DIR, "brain");
const ANNOTATIONS_DIR = join(AGY_DATA_DIR, "annotations");
const SUMMARIES_DB = join(AGY_DATA_DIR, "conversation_summaries.db");

function transcriptPath(id: string): string {
  return join(BRAIN_DIR, id, ".system_generated/logs/transcript_full.jsonl");
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

/** 读文件开头找第一条用户输入（只用于没有标题的会话）。 */
async function firstUserText(id: string): Promise<string> {
  const handle = await open(transcriptPath(id), "r").catch(() => null);
  if (!handle) return "";
  try {
    const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(256 * 1024), position: 0 });
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      try {
        const step: unknown = JSON.parse(line);
        if (isRecord(step) && step.type === "USER_INPUT" && typeof step.content === "string") {
          return userRequestText(step.content);
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

export class AgyAgent implements AgentProvider {
  readonly kind = "agy" as const;
  private readonly sessions = new Map<string, AgySession>();
  private status: AgentStatus | null = null;
  private models: ModelOption[] | null = null;
  /** 会话 id → 工作区（不会变，找到后一直缓存；没找到的按 transcript 的 mtime 重试）。 */
  private readonly workspaces = new Map<string, { workspace?: string; mtimeMs: number }>();
  private cache: SessionSummary[] | null = null;
  private loading: Promise<SessionSummary[]> | null = null;
  private generation = 0;
  private watchers: FSWatcher[] = [];
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly events: AgentEvents,
    private readonly getEnv: () => Record<string, string>,
    private readonly getPathOverride: () => string,
  ) {}

  async getStatus(refresh = false): Promise<AgentStatus> {
    if (!this.status || refresh) this.status = await probeCli("agy", "agy", this.getEnv(), this.getPathOverride());
    return this.status;
  }

  private async resolveLaunch(cwd: string, args: string[]): Promise<AgyLaunch> {
    const status = await this.getStatus();
    if (!status.found || !status.path) throw new Error("未找到 agy 命令，请在设置中指定路径");
    return { path: status.path, env: this.getEnv(), cwd, args };
  }

  /** `agy models` 每行是 “id<TAB>名称”。 */
  async listModels(): Promise<ModelOption[]> {
    if (this.models) return this.models;
    try {
      const { path, env } = await this.resolveLaunch(AGY_DATA_DIR, []);
      const { stdout } = await execFileAsync(path, ["models"], { env, timeout: 30_000 });
      const models = stdout
        .split("\n")
        .map((line) => line.split("\t"))
        .filter((parts) => parts.length >= 2 && parts[0]!.trim())
        .map(([value, label]) => ({ value: value!.trim(), label: label!.trim() }));
      if (models.length === 0) return AGENTS.agy.models;
      this.models = [AGENTS.agy.models[0]!, ...models];
    } catch {
      return AGENTS.agy.models;
    }
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
        maxBuffer: 4 * 1024 * 1024,
      });
      return agyQuota(stdout);
    } catch (error) {
      // 非 0 退出时 stdout 里可能仍有带错误说明的 JSON
      const stdout = isRecord(error) && typeof error.stdout === "string" ? error.stdout : "";
      return stdout.trim() ? agyQuota(stdout) : quotaError("agy", error);
    }
  }

  // ───────────────────────── 历史 ─────────────────────────

  async listSessions(): Promise<SessionSummary[]> {
    if (this.cache) return this.cache;
    if (!this.loading) {
      const generation = this.generation;
      this.loading = this.scanSessions()
        .then((list) => {
          if (generation === this.generation) this.cache = list;
          return list;
        })
        .catch(() => [] as SessionSummary[])
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }

  private async scanSessions(): Promise<SessionSummary[]> {
    const ids = await readdir(BRAIN_DIR).catch(() => [] as string[]);
    const summaries = readSummaryDb();
    const list = await Promise.all(ids.map((id) => this.summaryOf(id, summaries.get(id))));
    return list.filter((item): item is SessionSummary => item !== null).sort((a, b) => b.updatedAt - a.updatedAt);
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
    const title = (await annotationTitle(id)) || row?.title || (await firstUserText(id));
    return {
      id,
      agent: "agy",
      projectPath: cached.workspace,
      title: clip(title) || "未命名会话",
      createdAt: info.birthtimeMs || info.mtimeMs,
      updatedAt: info.mtimeMs,
    };
  }

  async loadSession(id: string, _projectPath: string): Promise<SessionLoadResult> {
    const steps = await readSteps(id);
    const summary = (await this.listSessions()).find((item) => item.id === id) ?? null;
    return { summary, rows: projectAgyHistory(steps).snapshot() };
  }

  /** agy 的标题存在 annotations/<id>.pbtxt（/resume 里改名写这里）；摘要库里的标题一并更新。 */
  async renameSession(id: string, projectPath: string, title: string): Promise<void> {
    const clean = title.replace(/[\r\n]+/g, " ").trim();
    const line = `title:"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const path = join(ANNOTATIONS_DIR, `${id}.pbtxt`);
    const current = await readFile(path, "utf8").catch(() => "");
    const next = /^title:.*$/m.test(current) ? current.replace(/^title:.*$/m, line) : `${line}\n${current}`;
    await writeFile(path, next);
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

  async send(params: ChatSendParams): Promise<{ sessionKey: string }> {
    let session = this.sessions.get(params.sessionKey);
    if (!session) {
      session = new AgySession(
        {
          resolveLaunch: (cwd, args) => this.resolveLaunch(cwd, args),
          emitRows: (key, ops) => this.events.rows(key, ops),
          emitState: (event) => this.events.state(event),
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
          ...(params.model ? { model: params.model } : {}),
        },
      );
      this.sessions.set(session.key, session);
      if (params.resumeSessionId) session.seedHistory(await readSteps(params.resumeSessionId).catch(() => []));
      session.emitState();
    } else if (session.permissionMode !== params.permissionMode) {
      await session.setPermissionMode(params.permissionMode);
    }
    void session.send(params.text, params.images, params.files);
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
    if (!session || session.isBusy) return;
    session.close();
    this.sessions.delete(sessionKey);
  }

  /** 无头模式没有审批请求。 */
  respondPermission(_interactionId: string, _decision: PermissionDecision): boolean {
    return false;
  }

  dispose() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}
