// 按 agent / sessionKey / interactionId 把调用路由到对应的 CLI 接入。
import type {
  AgentKind,
  AgentStatus,
  ChatSendParams,
  PermissionDecision,
  SessionSummary,
} from "../../shared/types.js";
import type { AgentProvider } from "./types.js";

export class AgentRegistry {
  constructor(private readonly providers: Record<AgentKind, AgentProvider>) {}

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

  statuses(refresh = false): Promise<AgentStatus[]> {
    return Promise.all(this.all().map((provider) => provider.getStatus(refresh)));
  }

  /** 所有 CLI 的会话合并，按更新时间倒序；某个 CLI 读取失败不影响其他。 */
  async allSessions(): Promise<SessionSummary[]> {
    const lists = await Promise.all(this.all().map((provider) => provider.listSessions().catch(() => [])));
    return lists.flat().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  send(params: ChatSendParams) {
    return this.get(params.agent).send(params);
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
    for (const provider of this.all()) provider.dispose();
  }
}
