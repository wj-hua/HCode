// 按 agent / sessionKey / interactionId 把调用路由到对应的 CLI 接入。
import type {
  AgentKind,
  AgentStatus,
  ChatStateEvent,
  PermissionDecision,
  SessionSummary,
} from "../../shared/types.js";
import type { AgentProvider, AgentSendParams } from "./types.js";

type PendingSession = Omit<SessionSummary, "id"> & { id?: string };
type SessionIdentity = Pick<SessionSummary, "agent" | "projectPath" | "id">;
const identityKey = (session: SessionIdentity) => JSON.stringify([session.agent, session.projectPath, session.id]);

export class AgentRegistry {
  /** 新会话保留到历史收录或删除，关闭视图、回合结束都不能让它从另一端消失。 */
  private readonly pendingSessions = new Map<string, PendingSession>();

  constructor(
    private readonly providers: Record<AgentKind, AgentProvider>,
    private readonly onIndexChanged: (projectPaths: string[]) => void = () => {},
  ) {}

  observeState(event: ChatStateEvent) {
    const session = this.pendingSessions.get(event.sessionKey);
    if (!session || session.agent !== event.agent || session.projectPath !== event.projectPath || !event.sessionId) return;
    if (session.id === event.sessionId) return;
    session.id = event.sessionId;
    this.onIndexChanged([session.projectPath]);
  }

  forgetSession(ref: SessionIdentity) {
    for (const [key, session] of this.pendingSessions) {
      if (session.id && identityKey({ ...session, id: session.id }) === identityKey(ref)) this.pendingSessions.delete(key);
    }
  }

  get(kind: AgentKind): AgentProvider {
    const provider = this.providers[kind];
    if (!provider) throw new Error(`不支持的 CLI：${kind}`);
    return provider;
  }

  all(): AgentProvider[] {
    return Object.values(this.providers);
  }

  bySessionKey(sessionKey: string): AgentProvider | undefined {
    return this.all().find((provider) => provider.hasSession(sessionKey));
  }

  liveRows(sessionKey: string) {
    return this.bySessionKey(sessionKey)?.liveRows(sessionKey);
  }

  /** 通知沿用会话列表标题；原生历史尚未收录的新会话使用本进程的列表占位。读取失败交由调用方处理。 */
  async sessionTitle(state: ChatStateEvent): Promise<string | undefined> {
    const pending = this.pendingSessions.get(state.sessionKey);
    const matchesPending = pending?.agent === state.agent && pending.projectPath === state.projectPath
      && (!state.sessionId || !pending.id || pending.id === state.sessionId);
    if (state.sessionId) {
      const sessions = await this.get(state.agent).listSessions();
      const summary = sessions.find(session => session.id === state.sessionId
        && session.agent === state.agent && session.projectPath === state.projectPath);
      if (summary?.title.trim()) return summary.title;
    }
    return matchesPending ? pending.title : undefined;
  }

  statuses(refresh = false): Promise<AgentStatus[]> {
    return Promise.all(this.all().map((provider) => provider.getStatus(refresh)));
  }

  /** 所有 CLI 的会话合并，按更新时间倒序；某个 CLI 读取失败不影响其他。 */
  async allSessions(refresh = false): Promise<SessionSummary[]> {
    const lists = await Promise.all(this.all().map((provider) => refresh ? provider.listSessions(true) : provider.listSessions().catch(() => [])));
    const sessions = lists.flat();
    const indexed = new Set(sessions.map(identityKey));
    for (const [key, session] of this.pendingSessions) {
      if (!session.id) continue;
      const summary = { ...session, id: session.id };
      if (indexed.has(identityKey(summary))) this.pendingSessions.delete(key);
      else sessions.push(summary);
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async send(params: AgentSendParams) {
    // 只补用户发起的新会话；内部研究、委派与历史续聊继续使用原生历史索引。
    if (!params.resumeSessionId && !params.research && !params.onNativeSession && !this.pendingSessions.has(params.sessionKey)) {
      const title = params.text.split("\n").map(line => line.trim()).find(Boolean) || "新会话";
      const now = Date.now();
      this.pendingSessions.set(params.sessionKey, {
        agent: params.agent, projectPath: params.projectPath,
        title: title.length > 80 ? `${title.slice(0, 80)}…` : title,
        createdAt: now, updatedAt: now,
      });
    }
    try {
      return await this.get(params.agent).send(params);
    } catch (error) {
      if (!this.pendingSessions.get(params.sessionKey)?.id) this.pendingSessions.delete(params.sessionKey);
      throw error;
    }
  }

  respondPermission(interactionId: string, decision: PermissionDecision) {
    for (const provider of this.all()) {
      if (provider.respondPermission(interactionId, decision)) return;
    }
  }

  startWatching() {
    for (const provider of this.all()) provider.startWatching();
  }

  dispose() {
    this.pendingSessions.clear();
    for (const provider of this.all()) provider.dispose();
  }
}
