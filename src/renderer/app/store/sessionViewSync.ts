// 保存本进程收到的原生会话快照；独立历史视图通过 CLI、项目和原生 ID 绑定真实执行身份。
import type { ChatRowsEvent, ChatStateEvent, ConversationRow, SessionSummary } from "@hcode/shared/types";
import { applyRowOps } from "../rows";
import type { Conversation } from "./appStore";

type SessionIdentity = Pick<SessionSummary, "agent" | "projectPath" | "id">;

function identityKey(identity: SessionIdentity): string {
  return JSON.stringify([identity.agent, identity.projectPath, identity.id]);
}

export class SessionViewSync {
  private readonly rows = new Map<string, ConversationRow[]>();
  private readonly states = new Map<string, ChatStateEvent>();
  private readonly nativeKeys = new Map<string, string>();
  private readonly startedAt = new Map<string, number>();
  private readonly historyLoads = new Map<string, symbol>();

  /** 同一页面关闭后重开会复用 viewId；只有最新一次读取能回写，不能仅靠 viewId 判断。 */
  beginHistoryLoad(viewId: string): () => boolean {
    const token = Symbol(viewId);
    this.historyLoads.set(viewId, token);
    return () => this.historyLoads.get(viewId) === token;
  }

  cancelHistoryLoad(viewId: string): void {
    this.historyLoads.delete(viewId);
  }

  /** 未打开的子会话也接收行，避免打开时从一份滞后的磁盘快照开始追加。 */
  captureRows(event: ChatRowsEvent): ConversationRow[] {
    const rows = applyRowOps(this.rows.get(event.sessionKey) ?? [], event.ops);
    this.rows.set(event.sessionKey, rows);
    return rows;
  }

  /** init 前后的状态共用执行 key；后续省略原生 ID 的通知仍保留已确认的关联。 */
  captureState(event: ChatStateEvent): ChatStateEvent {
    const previous = this.states.get(event.sessionKey);
    const state = { ...event, sessionId: event.sessionId ?? previous?.sessionId, model: event.model ?? previous?.model };
    this.states.set(event.sessionKey, state);
    if (state.sessionId) this.nativeKeys.set(identityKey({ ...state, id: state.sessionId }), state.sessionKey);
    if (state.state === "running" || state.state === "awaitingApproval" || state.backgroundTasks) {
      if (!this.startedAt.has(state.sessionKey)) this.startedAt.set(state.sessionKey, Date.now());
    } else this.startedAt.delete(state.sessionKey);
    return state;
  }

  /** 原生 ID 必须同时匹配 CLI 和项目；续接同一原生会话时允许切换到新的执行 key。 */
  match(state: ChatStateEvent, conversations: Record<string, Conversation>): Conversation | undefined {
    return Object.values(conversations).find(conversation => conversation.sessionKey === state.sessionKey)
      ?? Object.values(conversations).find(conversation => state.sessionId && conversation.sessionId === state.sessionId
        && conversation.agent === state.agent && conversation.projectPath === state.projectPath);
  }

  /** 同一快照同时提供内容和状态，历史加载完成后也必须重新取一次，不能覆盖期间的流式输出。 */
  viewPatch(identity: SessionIdentity): Partial<Conversation> | undefined {
    const sessionKey = this.nativeKeys.get(identityKey(identity));
    const state = sessionKey ? this.states.get(sessionKey) : undefined;
    if (!state) return undefined;
    const rows = this.rows.get(state.sessionKey);
    return {
      sessionKey: state.sessionKey,
      runState: state.state,
      backgroundTasks: state.backgroundTasks,
      runStartedAt: this.startedAt.get(state.sessionKey),
      error: state.error,
      permissionMode: state.permissionMode,
      ...(rows ? { rows, loading: false, loadError: undefined } : {}),
      ...(state.model ? { activeModel: state.model } : {}),
      ...(state.usage ? { usage: state.usage } : {}),
    };
  }

  /** 关闭执行连接后只保留磁盘历史，不能把缓存里的旧连接当作可续聊的活动进程。 */
  forget(sessionKey: string): void {
    const state = this.states.get(sessionKey);
    if (state?.sessionId) {
      const key = identityKey({ ...state, id: state.sessionId });
      if (this.nativeKeys.get(key) === sessionKey) this.nativeKeys.delete(key);
    }
    this.rows.delete(sessionKey);
    this.states.delete(sessionKey);
    this.startedAt.delete(sessionKey);
  }
}
