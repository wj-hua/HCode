// StepCode 接入：历史读取会话 JSONL（step 没有列会话的 RPC 命令，格式见 step 自带的 docs/session-format.md），
// 实时会话、审批、改名、模型列表都走 `step --mode rpc`。
import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENTS } from "../../../shared/agents.js";
import type {
  AgentStatus,
  ChatSendParams,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  SessionLoadResult,
  SessionSummary,
} from "../../../shared/types.js";
import { probeCli } from "../../util/locateCli.js";
import { isRecord } from "../rowProjectorBase.js";
import type { AgentEvents, AgentProvider } from "../types.js";
import { projectStepHistory, type StepEntry } from "./stepProjector.js";
import { StepRpcProcess, type StepLaunch } from "./stepRpc.js";
import { StepSession } from "./stepSession.js";

/** 官方安装脚本的位置；优先于 PATH，避免和同名的 smallstep `step` 命令混淆。 */
const STEP_BIN = join(homedir(), ".stepcode/bin/step");

interface ParsedSession {
  header: { id: string; cwd: string; timestamp?: string };
  entries: StepEntry[];
}

async function readSessionFile(path: string): Promise<ParsedSession | null> {
  const text = await readFile(path, "utf8");
  let header: ParsedSession["header"] | null = null;
  const entries: StepEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    if (record.type === "session") {
      if (typeof record.id === "string" && typeof record.cwd === "string") {
        header = { id: record.id, cwd: record.cwd, ...(typeof record.timestamp === "string" ? { timestamp: record.timestamp } : {}) };
      }
    } else if (typeof record.id === "string") {
      entries.push(record as StepEntry);
    }
  }
  return header ? { header, entries } : null;
}

function firstUserText(entries: readonly StepEntry[]): string {
  for (const entry of entries) {
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "user") continue;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join(" ")
          : "";
    if (text.trim()) return text;
  }
  return "";
}

function toSummary(parsed: ParsedSession, mtimeMs: number): SessionSummary {
  let name = "";
  for (const entry of parsed.entries) {
    if (entry.type === "session_info") name = typeof entry.name === "string" ? entry.name : "";
  }
  const raw = (name || firstUserText(parsed.entries)).trim().split("\n")[0]!.trim();
  const createdAt = parsed.header.timestamp ? Date.parse(parsed.header.timestamp) || mtimeMs : mtimeMs;
  return {
    id: parsed.header.id,
    agent: "step",
    projectPath: parsed.header.cwd,
    title: raw.length > 80 ? `${raw.slice(0, 80)}…` : raw || "未命名会话",
    createdAt,
    updatedAt: mtimeMs,
  };
}

export class StepAgent implements AgentProvider {
  readonly kind = "step" as const;
  private readonly sessions = new Map<string, StepSession>();
  private status: AgentStatus | null = null;
  private models: ModelOption[] | null = null;
  /** 会话文件路径 → 按 mtime 缓存的摘要 */
  private readonly fileCache = new Map<string, { mtimeMs: number; summary: SessionSummary | null }>();
  /** 会话 id → 会话文件路径 */
  private readonly paths = new Map<string, string>();
  private cache: SessionSummary[] | null = null;
  private loading: Promise<SessionSummary[]> | null = null;
  private generation = 0;
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly events: AgentEvents,
    private readonly getEnv: () => Record<string, string>,
    private readonly getPathOverride: () => string,
  ) {}

  /** 与 step 自己的规则一致：STEP_CODING_AGENT_SESSION_DIR > STEP_CODING_AGENT_DIR/sessions > ~/.stepcode/agent/sessions */
  private sessionsDir(): string {
    const env = this.getEnv();
    return (
      env.STEP_CODING_AGENT_SESSION_DIR ||
      join(env.STEP_CODING_AGENT_DIR || join(homedir(), ".stepcode/agent"), "sessions")
    );
  }

  async getStatus(refresh = false): Promise<AgentStatus> {
    if (!this.status || refresh) {
      const override = this.getPathOverride() || (existsSync(STEP_BIN) ? STEP_BIN : "");
      this.status = await probeCli("step", "step", this.getEnv(), override);
    }
    return this.status;
  }

  private async resolveLaunch(cwd: string, args: string[]): Promise<StepLaunch> {
    const status = await this.getStatus();
    if (!status.found || !status.path) throw new Error("未找到 step 命令，请在设置中指定路径");
    return { path: status.path, env: this.getEnv(), cwd, args };
  }

  /** 起一个临时的 step RPC 进程做一次性查询（模型列表、给不在运行的会话改名）。 */
  private async withTempProcess<T>(cwd: string, args: string[], run: (rpc: StepRpcProcess) => Promise<T>): Promise<T> {
    const rpc = new StepRpcProcess(await this.resolveLaunch(cwd, args));
    try {
      return await run(rpc);
    } finally {
      rpc.dispose();
    }
  }

  async listModels(): Promise<ModelOption[]> {
    if (this.models) return this.models;
    try {
      const result = await this.withTempProcess(homedir(), ["--no-session"], (rpc) =>
        rpc.request<{ models: { provider: string; id: string; name?: string }[] }>("get_available_models"),
      );
      this.models = [
        AGENTS.step.models[0]!,
        ...result.models.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name || model.id })),
      ];
    } catch {
      return AGENTS.step.models;
    }
    return this.models;
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
    const root = this.sessionsDir();
    const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
    const files = (
      await Promise.all(
        dirs
          .filter((dir) => dir.isDirectory())
          .map(async (dir) => {
            const names = await readdir(join(root, dir.name)).catch(() => [] as string[]);
            return names.filter((name) => name.endsWith(".jsonl")).map((name) => join(root, dir.name, name));
          }),
      )
    ).flat();
    const summaries = await Promise.all(files.map((file) => this.summaryOf(file)));
    return summaries.filter((item): item is SessionSummary => item !== null).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async summaryOf(file: string): Promise<SessionSummary | null> {
    try {
      const info = await stat(file);
      const cached = this.fileCache.get(file);
      if (cached && cached.mtimeMs === info.mtimeMs) return cached.summary;
      const parsed = await readSessionFile(file);
      // 只有元数据、还没有任何消息的会话不列出
      const hasUser = parsed?.entries.some((entry) => entry.type === "message" && entry.message?.role === "user");
      const summary = parsed && hasUser ? toSummary(parsed, info.mtimeMs) : null;
      this.fileCache.set(file, { mtimeMs: info.mtimeMs, summary });
      if (summary) this.paths.set(summary.id, file);
      return summary;
    } catch {
      return null;
    }
  }

  private async sessionPath(id: string): Promise<string> {
    if (!this.paths.has(id)) await this.listSessions();
    const path = this.paths.get(id);
    if (!path) throw new Error("找不到这个 StepCode 会话文件");
    return path;
  }

  async loadSession(id: string, _projectPath: string): Promise<SessionLoadResult> {
    const parsed = await readSessionFile(await this.sessionPath(id));
    const summary = (await this.listSessions()).find((item) => item.id === id) ?? null;
    return { summary, rows: parsed ? projectStepHistory(parsed.entries).snapshot() : [] };
  }

  async renameSession(id: string, projectPath: string, title: string): Promise<void> {
    const live = [...this.sessions.values()].find((session) => session.sessionId === id);
    if (!(await live?.rename(title))) {
      const path = await this.sessionPath(id);
      await this.withTempProcess(projectPath, ["--session", path], (rpc) => rpc.request("set_session_name", { name: title }));
    }
    this.invalidate([projectPath]);
  }

  async resumeCommand(sessionId: string): Promise<string[]> {
    const status = await this.getStatus();
    return [status.path ?? "step", "--session", sessionId];
  }

  private invalidate(projectPaths: string[] = []) {
    this.generation++;
    this.cache = null;
    this.loading = null;
    this.events.indexChanged(projectPaths);
  }

  startWatching() {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.sessionsDir(), { recursive: true }, (_event, filename) => {
        if (filename && !filename.endsWith(".jsonl")) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.invalidate(), 800);
      });
    } catch {
      // 没用过 step 时目录不存在
    }
  }

  // ───────────────────────── 实时会话 ─────────────────────────

  hasSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  async send(params: ChatSendParams): Promise<{ sessionKey: string }> {
    let session = this.sessions.get(params.sessionKey);
    if (!session) {
      const file = params.resumeSessionId ? await this.sessionPath(params.resumeSessionId) : undefined;
      session = new StepSession(
        {
          resolveLaunch: (cwd, args) => this.resolveLaunch(cwd, args),
          emitRows: (key, ops) => this.events.rows(key, ops),
          emitState: (event) => this.events.state(event),
          emitPermission: (event) => this.events.permission(event),
          emitPermissionResolved: (event) => this.events.permissionResolved(event),
          onSettled: (done) => this.invalidate([done.projectPath]),
        },
        {
          key: params.sessionKey,
          projectPath: params.projectPath,
          ...(params.resumeSessionId ? { sessionId: params.resumeSessionId } : {}),
          ...(file ? { sessionFile: file } : {}),
          permissionMode: params.permissionMode,
          ...(params.model ? { model: params.model } : {}),
        },
      );
      this.sessions.set(session.key, session);
      if (file) {
        const parsed = await readSessionFile(file);
        if (parsed) session.seedHistory(parsed.entries);
      }
      session.emitState();
    } else if (session.permissionMode !== params.permissionMode) {
      await session.setPermissionMode(params.permissionMode);
    }
    void session.send(params.text, params.images);
    return { sessionKey: session.key };
  }

  private require(sessionKey: string): StepSession {
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

  respondPermission(interactionId: string, decision: PermissionDecision): boolean {
    for (const session of this.sessions.values()) {
      if (session.ownsInteraction(interactionId)) {
        session.respondPermission(interactionId, decision);
        return true;
      }
    }
    return false;
  }

  dispose() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.watcher?.close();
  }
}
