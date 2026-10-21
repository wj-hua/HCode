// 原生建议只保存在内存；按会话和回合隔离，接受/忽略后同轮迟到事件不能重新填回草稿。
import { create } from 'zustand';
import type { ChatPromptSuggestionEvent } from '@hcode/shared/types';
import type { Conversation } from '../store/appStore';

interface SuggestionRecord { event: ChatPromptSuggestionEvent; dismissed: boolean; order: number }
interface PromptSuggestionState {
  records: Record<string, SuggestionRecord>;
  order: number;
  accept(event: ChatPromptSuggestionEvent): void;
  dismiss(sessionKey: string, turnId: string): void;
}
type SuggestionIdentity = Pick<Conversation, 'agent' | 'projectPath' | 'sessionKey' | 'sessionId'>;

export const usePromptSuggestionStore = create<PromptSuggestionState>(set => ({
  records: {}, order: 0,
  accept: event => set(state => {
    if (event.agent !== 'claude') return state;
    const previous = state.records[event.sessionKey];
    if (previous && event.revision <= previous.event.revision) return state;
    return { order: state.order + 1, records: { ...state.records, [event.sessionKey]: {
      event, order: state.order + 1, dismissed: previous?.event.turnId === event.turnId && previous.dismissed,
    } } };
  }),
  dismiss: (sessionKey, turnId) => set(state => {
    const record = state.records[sessionKey];
    if (!record || record.event.turnId !== turnId || record.dismissed) return state;
    return { records: { ...state.records, [sessionKey]: { ...record, dismissed: true } } };
  }),
}));

/** 同一原生会话重新打开时可取回最新建议；相同 sessionKey 也必须核对项目、后端与身份。 */
export function promptSuggestionRecord(records: Record<string, SuggestionRecord>, identity: SuggestionIdentity) {
  if (identity.agent !== 'claude') return undefined;
  return Object.values(records).filter(({ event }) => event.agent === identity.agent && event.projectPath === identity.projectPath &&
    (event.sessionKey === identity.sessionKey && (!identity.sessionId || !event.sessionId || event.sessionId === identity.sessionId)
      || Boolean(identity.sessionId && identity.sessionId === event.sessionId)))
    .sort((left, right) => right.order - left.order)[0];
}

export function visiblePromptSuggestion(record: SuggestionRecord | undefined, text: string, enabled: boolean) {
  return enabled && text.length === 0 && record && !record.dismissed ? record.event.suggestion : null;
}
