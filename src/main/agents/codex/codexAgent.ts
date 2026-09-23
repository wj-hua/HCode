// Codex 接入：历史（thread/list、thread/turns/list）+ 实时会话 + 审批，全部通过一个共享的 codex app-server。
import { watch, type FSWatcher } from "node:fs";
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
import { AppServerClient, type ServerRequest } from "./appServerClient.js";
import { projectCodexTurns, type CodexTurn } from "./codexProjector.js";
import { CodexSession } from "./codexSession.js";

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
/** 列表里只显示人发起的会话（不含子 agent / 自动审查等内部线程）。 */
const LISTED_SOURCES = ["cli", "vscode", "exec", "appServer"];

interface CodexThread {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number | null;
  parentThreadId?: string | null;
  ephemeral?: boolean;
  gitInfo?: { branch?: string | null } | null;
}

function toSummary(thread: CodexThread): SessionSummary | null {
  if (!thread.cwd || thread.parentThreadId || thread.ephemeral) return null;
  const raw = (thread.name || thread.preview || "未命名会话").trim().split("\n")[0]!.trim();
  const updated = (thread.recencyAt ?? thread.updatedAt) * 1000;
  return {
    id: thread.id,
    agent: "codex",
    projectPath: thread.cwd,
    title: raw.length > 80 ? `${raw.slice(0, 80)}…` : raw || "未命名会话",
    createdAt: thread.createdAt * 1000,
    updatedAt: updated,
    ...(thread.gitInfo?.branch ? { gitBranch: thread.gitInfo.branch } : {}),
  };
}

export class CodexAgent implements AgentProvider {
  readonly kind = "codex" as const;
  private readonly client: AppServerClient;
  private readonly sessions = new Map<string, CodexSession>();
  private status: AgentStatus | null = null;
  private cache: SessionSummary[] | null = null;
  private loading: Promise<SessionSummary[]> | null = null;
  private models: ModelOption[] | null = null;
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  /** 每次失效 +1；进行中的列表请求返回时如果代数已变，就不写缓存。 */
  private generation = 0;

  constructor(
    private readonly events: AgentEvents,
    private readonly getEnv: () => Record<string, string>,
    private readonly getPathOverride: () => string,
  ) {
    this.client = new AppServerClient(async () => {
      const status = await this.getStatus();
      if (!status.found || !status.path) throw new Error("未找到 codex 命令，请在设置中指定路径");
      return { path: status.path, env: this.getEnv() };
    });
    this.client.on("notification", (method: string, params: Record<string, unknown>) =>
      this.onNotification(method, params),
    );
    this.client.on("request", (request: ServerRequest) => this.onServerRequest(request));
    this.client.on("exit", (reason: string) => {
      for (const session of this.sessions.values()) session.detach(reason);
    });
  }

  async getStatus(refresh = false): Promise<AgentStatus> {
    if (!this.status || refresh) {
      this.status = await probeCli("codex", "codex", this.getEnv(), this.getPathOverride());
    }
    return this.status;
  }

  async listModels(): Promise<ModelOption[]> {
    if (this.models) return this.models;
    try {
      const result = await this.client.call<{ data: { model: string; displayName: string; description: string; hidden: boolean }[] }>(
        "model/list",
        {},
      );
      this.models = [
        AGENTS.codex.models[0]!,
        ...result.data
          .filter((model) => !model.hidden)
          .map((model) => ({ value: model.model, label: model.displayName || model.model, description: model.description })),
      ];
    } catch {
      return AGENTS.codex.models;
    }
    return this.models;
  }

  // ───────────────────────── 历史 ─────────────────────────

  async listSessions(): Promise<SessionSummary[]> {
    if (this.cache) return this.cache;
    const status = await this.getStatus();
    if (!status.found) return [];
    if (!this.loading) {
      const generation = this.generation;
      this.loading = this.fetchAllThreads()
        .then((threads) => {
          const list = threads
            .map(toSummary)
            .filter((item): item is SessionSummary => item !== null)
            .sort((a, b) => b.updatedAt - a.updatedAt);
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

  private async fetchAllThreads(): Promise<CodexThread[]> {
    const threads: CodexThread[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const result: { data: CodexThread[]; nextCursor: string | null } = await this.client.call("thread/list", {
        limit: 200,
        sortKey: "updated_at",
        sourceKinds: LISTED_SOURCES,
        useStateDbOnly: true,
        ...(cursor ? { cursor } : {}),
      });
      threads.push(...result.data);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return threads;
  }

  private async loadTurns(threadId: string): Promise<CodexTurn[]> {
    const turns: CodexTurn[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 200; page++) {
      const result: { data: CodexTurn[]; nextCursor: string | null } = await this.client.call("thread/turns/list", {
        threadId,
        itemsView: "full",
        sortDirection: "asc",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      turns.push(...result.data);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return turns;
  }

  async loadSession(id: string, _projectPath: string): Promise<SessionLoadResult> {
    const turns = await this.loadTurns(id);
    const summary = (await this.listSessions()).find((item) => item.id === id) ?? null;
    return { summary, rows: projectCodexTurns(turns).snapshot() };
  }

  async renameSession(id: string, projectPath: string, title: string): Promise<void> {
    await this.client.call("thread/name/set", { threadId: id, name: title });
    this.invalidate([projectPath]);
  }

  async resumeCommand(sessionId: string): Promise<string[]> {
    const status = await this.getStatus();
    return [status.path ?? "codex", "resume", sessionId];
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
      this.watcher = watch(join(CODEX_HOME, "sessions"), { recursive: true }, (_event, filename) => {
        if (filename && !filename.endsWith(".jsonl")) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.invalidate(), 800);
      });
    } catch {
      // 没用过 codex 时目录不存在
    }
  }

  // ───────────────────────── 实时会话 ─────────────────────────

  hasSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  async send(params: ChatSendParams): Promise<{ sessionKey: string }> {
    let session = this.sessions.get(params.sessionKey);
    if (!session) {
      await this.client.ensureStarted();
      session = new CodexSession(
        {
          client: this.client,
          emitRows: (key, ops) => this.events.rows(key, ops),
          emitState: (event) => this.events.state(event),
          emitPermission: (event) => this.events.permission(event),
          emitPermissionResolved: (event) => this.events.permissionResolved(event),
          onThreadId: (created) => this.invalidate([created.projectPath]),
          onTurnCompleted: (done) => this.invalidate([done.projectPath]),
        },
        {
          key: params.sessionKey,
          projectPath: params.projectPath,
          ...(params.resumeSessionId ? { threadId: params.resumeSessionId } : {}),
          permissionMode: params.permissionMode,
          ...(params.model ? { model: params.model } : {}),
        },
      );
      this.sessions.set(session.key, session);
      if (params.resumeSessionId) session.seedHistory(await this.loadTurns(params.resumeSessionId));
      session.emitState();
    } else if (session.permissionMode !== params.permissionMode) {
      await session.setPermissionMode(params.permissionMode);
    }
    void session.send(params.text, params.images);
    return { sessionKey: session.key };
  }

  private sessionForThread(threadId: unknown): CodexSession | undefined {
    if (typeof threadId !== "string") return undefined;
    for (const session of this.sessions.values()) {
      if (session.threadId === threadId) return session;
    }
    return undefined;
  }

  private onNotification(method: string, params: Record<string, unknown>) {
    if (method === "thread/name/updated" || method === "thread/started") {
      this.invalidate();
    }
    if (method === "serverRequest/resolved") {
      this.sessionForThread(params.threadId)?.resolveServerRequest(params.requestId as number | string);
      return;
    }
    const threadId = params.threadId ?? (isRecord(params.thread) ? params.thread.id : undefined);
    this.sessionForThread(threadId)?.handleNotification(method, params);
  }

  private onServerRequest(request: ServerRequest) {
    const session = this.sessionForThread(request.params.threadId);
    if (session?.handleServerRequest(request)) return;
    // 不认识或不属于任何会话的请求：拒绝，避免 app-server 一直等待
    if (request.method === "mcpServer/elicitation/request") {
      this.client.respond(request.id, { action: "decline", content: null, _meta: null });
    } else if (request.method.endsWith("requestApproval") || request.method.endsWith("Approval")) {
      this.client.respond(request.id, { decision: "decline" });
    } else {
      this.client.respondError(request.id, `HCode 不支持 ${request.method}`);
    }
  }

  private require(sessionKey: string): CodexSession {
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
    this.client.dispose();
  }
}
