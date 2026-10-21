// 只控制建议的显示/消费；实际草稿仍由 Composer 管理，不因原生建议自动改变。
import type { Conversation } from '../store/appStore';
import { promptSuggestionRecord, usePromptSuggestionStore, visiblePromptSuggestion } from './promptSuggestionStore';

export function usePromptSuggestion(conversation: Conversation, text: string, enabled: boolean) {
  const records = usePromptSuggestionStore(state => state.records);
  const record = promptSuggestionRecord(records, conversation);
  const suggestion = visiblePromptSuggestion(record, text, enabled);
  const dismiss = () => {
    if (record) usePromptSuggestionStore.getState().dismiss(record.event.sessionKey, record.event.turnId);
  };
  return { suggestion, dismiss };
}
