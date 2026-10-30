// 只控制建议的显示/消费；实际草稿仍由 Composer 管理，不因原生建议自动改变。
import type { Conversation } from '../store/appStore';
import { promptSuggestionRecord, usePromptSuggestionStore, visiblePromptSuggestion } from './promptSuggestionStore';

export type PromptSuggestionKeyAction = 'accept' | 'dismiss';
interface SuggestionKey { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }

export function usePromptSuggestion(conversation: Conversation, text: string, enabled: boolean) {
  const records = usePromptSuggestionStore(state => state.records);
  const record = promptSuggestionRecord(records, conversation);
  const suggestion = visiblePromptSuggestion(record, text, enabled);
  const dismiss = () => {
    if (record) usePromptSuggestionStore.getState().dismiss(record.event.sessionKey, record.event.turnId);
  };
  return { suggestion, dismiss };
}

/**
 * 建议仅在空输入框显示，接管这些键不会抢走光标移动或发送。桌面用 Tab 或 →（同 Codex）；
 * 手机软键盘没有这两个键，窄屏远程改用回车填入草稿，仍不直接发送。带修饰键或输入法组字时不接管。
 */
export function promptSuggestionKeyAction(event: SuggestionKey, narrow: boolean): PromptSuggestionKeyAction | null {
  if (event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === 'Escape') return 'dismiss';
  if (event.key === 'Tab' || event.key === 'ArrowRight') return 'accept';
  return narrow && event.key === 'Enter' ? 'accept' : null;
}
