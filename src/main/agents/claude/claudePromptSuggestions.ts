// Claude 原生建议没有 turn_id；只接收可关联的成功回合，避免排队输入后把迟到建议贴到下一轮。
import type { ChatPromptSuggestionEvent } from '../../../shared/types.js';

interface SuggestionTurn { id: string; sessionId?: string; eligible: boolean }

export class ClaudePromptSuggestions {
  private revision = 0;
  private turn?: SuggestionTurn;
  private awaiting = false;
  private ambiguous = false;

  constructor(private readonly identity: Pick<ChatPromptSuggestionEvent, 'sessionKey' | 'projectPath'>, private readonly emit: (event: ChatPromptSuggestionEvent) => void) {}

  /** 原生首轮不产生建议；复用 query 时若上一建议尚未到达，无法可靠判别后续事件的回合。 */
  begin(id: string, sessionId: string | undefined, enabled: boolean, freshQuery: boolean) {
    this.ambiguous = freshQuery ? false : this.ambiguous || this.awaiting;
    this.awaiting = false;
    this.turn = { id, sessionId, eligible: enabled && Boolean(sessionId) && !this.ambiguous };
    this.publish(null);
  }

  complete(succeeded: boolean, sessionId: string) {
    if (!this.turn) return;
    this.turn.sessionId = sessionId;
    this.awaiting = succeeded && this.turn.eligible;
    if (!succeeded) this.clear();
  }

  receive(suggestion: string, sessionId: string) {
    if (!this.awaiting || !this.turn || sessionId !== this.turn.sessionId) return;
    this.awaiting = false;
    const text = suggestion.trim();
    if (text) this.publish(text);
  }

  /** 取消、关闭或切换运行时后，成功 result 也不能重新准入旧建议。 */
  clear() {
    this.awaiting = false;
    if (!this.turn) return;
    this.turn.eligible = false;
    this.publish(null);
  }

  private publish(suggestion: string | null) {
    if (!this.turn) return;
    this.emit({ ...this.identity, agent: 'claude', turnId: this.turn.id, sessionId: this.turn.sessionId, revision: ++this.revision, suggestion });
  }
}
