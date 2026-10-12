import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AGENTS } from "../../../shared/agents.js";
import type { AgentStatus, ModelOption, PermissionDecision, PermissionMode, SessionLoadResult, SessionSummary } from "../../../shared/types.js";
import { probeCli } from "../../util/locateCli.js";
import { trashPaths } from "../../util/trash.js";
import { isRecord, type JsonRecord } from "../rowProjectorBase.js";
import type { AgentEvents, AgentProvider, AgentSendParams } from "../types.js";
import { ClineClient, type ClineLaunch } from "./clineClient.js";
import { clineDataDir, clineMessagesPath, clineSummary, readClineMessages } from "./clineHistory.js";
import { ClineRowProjector } from "./clineProjector.js";
import { ClineSession } from "./clineSession.js";
import { CLINE_EFFORTS, clineEnvironment, clineModelValue, clineProviderLabel, configuredClineModels, readClineConfig } from "./clineConfig.js";

const execFileAsync = promisify(execFile);
const EFFORTS = CLINE_EFFORTS;

export class ClineAgent implements AgentProvider {
  readonly kind = "cline" as const;
  private status: AgentStatus | undefined;
  private readonly sessions = new Map<string, ClineSession>();
  private history: JsonRecord[] | undefined;
  private loading: Promise<JsonRecord[]> | undefined;
  private generation = 0;
  private watcher: FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private modelClient: ClineClient | undefined;
  private modelLoading: Promise<ModelOption[]> | undefined;

  constructor(
    private readonly events: AgentEvents,
    private readonly getEnv: () => Record<string, string>,
    private readonly getPathOverride: () => string,
    private readonly attachmentsRoot: string,
  ) {}

  async getStatus(refresh = false): Promise<AgentStatus> {
    if (!this.status || refresh) this.status = await probeCli("cline", "cline", this.getEnv(), this.getPathOverride());
    return this.status;
  }

  private async launch(cwd: string, effort?: string, model?: string): Promise<ClineLaunch> {
    const status = await this.getStatus();
    if (!status.found || !status.path) throw new Error("未找到 cline 命令，请在设置中指定路径");
    const env = this.getEnv();
    const resolved = clineEnvironment(env, await readClineConfig(env), model);
    return { path: status.path, ...resolved, cwd, effort };
  }

  private async command(args: string[]): Promise<string> {
    const { path, env } = await this.launch(homedir());
    const { stdout } = await execFileAsync(path, args, { env, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  }

  async listModels(): Promise<ModelOption[]> {
    if (!(await this.getStatus()).found) return AGENTS.cline.models;
    if (!this.modelLoading) this.modelLoading = this.probeModels().finally(() => { this.modelLoading = undefined; });
    return this.modelLoading;
  }

  private async probeModels(): Promise<ModelOption[]> {
    const env = this.getEnv();
    const config = await readClineConfig(env);
    const resolved = clineEnvironment(env, config);
    const status = await this.getStatus();
    if (!status.path) throw new Error("未找到 cline 命令，请在设置中指定路径");
    const client = new ClineClient({ path: status.path, ...resolved, cwd: homedir() });
    this.modelClient = client;
    client.on("request", (request: { id: number | string }) => client.unsupported(request.id));
    try {
      await client.initialize();
      // session/new 只分配内存会话；不发 prompt，不产生历史或模型费用。
      const result = await client.request<JsonRecord>("session/new", { cwd: homedir(), mcpServers: [] });
      const models = isRecord(result.models) && Array.isArray(result.models.availableModels) ? result.models.availableModels.filter(isRecord) : [];
      const options = new Map(configuredClineModels(config, env).map((option) => [option.value, option]));
      for (const model of models) {
        if (typeof model.modelId !== "string" || !model.modelId) continue;
        const value = resolved.provider ? clineModelValue(resolved.provider, model.modelId) : model.modelId;
        const label = typeof model.name === "string" ? model.name : model.modelId;
        options.set(value, { value, label: resolved.provider ? `${clineProviderLabel(config, resolved.provider)} · ${label}` : label, efforts: EFFORTS });
      }
      if (!options.size) throw new Error("Cline 没有返回可用模型，请检查提供商配置");
      return [AGENTS.cline.models[0]!, ...options.values()];
    } finally {
      client.dispose();
      await client.closed;
      if (this.modelClient === client) this.modelClient = undefined;
    }
  }

  private async historyRows(): Promise<JsonRecord[]> {
    if (this.history) return this.history;
    if (!this.loading) {
      const generation = this.generation;
      const loading = this.command(["history", "--json", "--limit", "2147483647"]).then((stdout) => {
        const value: unknown = JSON.parse(stdout);
        if (!Array.isArray(value)) throw new Error("Cline 历史列表格式无法识别");
        const rows = value.filter(isRecord);
        if (this.generation === generation) this.history = rows;
        return rows;
      }).finally(() => { if (this.loading === loading) this.loading = undefined; });
      this.loading = loading;
    }
    return this.loading;
  }

  async listSessions(): Promise<SessionSummary[]> {
    if (!(await this.getStatus()).found) return [];
    this.startWatching();
    return (await this.historyRows()).map(clineSummary).filter((row): row is SessionSummary => row !== null).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  sessionFilePath(id: string) {
    const row = this.history?.find((row) => row.sessionId === id);
    return typeof row?.messagesPath === "string" ? row.messagesPath : undefined;
  }
  async loadSession(id: string, _projectPath: string): Promise<SessionLoadResult> {
    const row = (await this.historyRows()).find((row) => row.sessionId === id);
    if (!row) throw new Error("找不到这个 Cline 会话");
    const projector = await this.historyProjector(id);
    return { summary: clineSummary(row), rows: projector.snapshot() };
  }
  private async historyProjector(id: string): Promise<ClineRowProjector> {
    // 新会话尚未进入列表缓存，直接读取原生消息文件，也避免每轮另起 history 进程。
    const row = this.history?.find((row) => row.sessionId === id) ?? { messagesPath: clineMessagesPath(id, this.getEnv()) };
    const projector = new ClineRowProjector();
    projector.history(await readClineMessages(row));
    return projector;
  }
  async renameSession(id: string, projectPath: string, title: string) {
    await this.command(["history", "update", "--session-id", id, "--title", title.replace(/[\r\n]+/g, " ").trim(), "--json"]);
    this.invalidate([projectPath]);
  }
  async deleteSession(id: string, projectPath: string) {
    // 原生命令会连同子会话永久删除；先把可恢复的会话文件副本放进废纸篓。
    const rows = (await this.historyRows()).filter((row) => row.sessionId === id || row.parentSessionId === id);
    if (!rows.some((row) => row.sessionId === id)) throw new Error("找不到这个 Cline 会话");
    const backup = await mkdtemp(join(tmpdir(), "hcode-cline-session-"));
    try {
      await writeFile(join(backup, "history.json"), JSON.stringify(rows, null, 2));
      const env = this.getEnv();
      const sessionsDir = env.CLINE_SESSION_DATA_DIR?.trim() || join(clineDataDir(env), "sessions");
      for (const [index, row] of rows.entries()) {
        const sessionId = String(row.sessionId);
        if (sessionId === "." || sessionId === ".." || /[/\\]/.test(sessionId)) throw new Error("Cline 会话 ID 无效");
        await cp(join(sessionsDir, sessionId), join(backup, `session-${index}`), { recursive: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        if (typeof row.messagesPath === "string") await cp(row.messagesPath, join(backup, `messages-${index}.json`)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      await trashPaths([backup]);
      await this.command(["history", "delete", "--session-id", id, "--json"]);
    } finally { await rm(backup, { recursive: true, force: true }); }
    this.invalidate([projectPath]);
  }
  async resumeCommand(id: string) { return [(await this.getStatus()).path ?? "cline", "--id", id]; }

  async send(params: AgentSendParams) {
    if (params.research) throw new Error("Cline 尚未支持多 AI 协作");
    if (!["default", "plan", "bypass"].includes(params.permissionMode)) throw new Error("Cline 不支持此权限模式");
    if (params.effort && !EFFORTS.includes(params.effort)) throw new Error("Cline 不支持此思考强度");
    let session = this.sessions.get(params.sessionKey);
    if (session?.running) throw new Error("Cline 会话仍在运行，请先停止当前回合");
    if (session && session.projectPath !== params.projectPath) throw new Error("不能更改已有 Cline 会话的工作目录");
    if (!session) {
      session = new ClineSession(params, this.events, (cwd, effort, model) => this.launch(cwd, effort, model), this.attachmentsRoot, () => this.invalidate([params.projectPath]), (id) => this.historyProjector(id));
      this.sessions.set(params.sessionKey, session);
    }
    void session.send(params);
    return { sessionKey: params.sessionKey };
  }
  hasSession(key: string) { return this.sessions.has(key); }
  async interrupt(key: string) { await this.sessions.get(key)?.interrupt(); }
  async setPermissionMode(key: string, mode: PermissionMode) { await this.require(key).setPermissionMode(mode); }
  async setModel(key: string, model: string) { await this.require(key).setModel(model); }
  private require(key: string) {
    const session = this.sessions.get(key);
    if (!session) throw new Error("会话不存在或已关闭");
    return session;
  }
  closeSession(key: string) { this.sessions.get(key)?.dispose(); this.sessions.delete(key); }
  respondPermission(id: string, decision: PermissionDecision) {
    for (const session of this.sessions.values()) if (session.respondPermission(id, decision)) return true;
    return false;
  }
  private invalidate(paths: string[] = []) {
    this.generation++;
    this.history = undefined;
    this.loading = undefined;
    this.events.indexChanged(paths);
  }
  startWatching() {
    if (this.watcher) return;
    try {
      this.watcher = watch(clineDataDir(this.getEnv()), { recursive: true }, (_event, filename) => {
        if (filename && !String(filename).includes("sessions") && !String(filename).endsWith(".messages.json")) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.invalidate(), 800);
      });
    } catch { /* 从未运行过 Cline 时目录可能不存在 */ }
  }
  dispose() {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.modelClient?.dispose();
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
  }
}
