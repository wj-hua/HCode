// 原生建议只可显式接受为草稿；按钮不提交表单，键盘 Tab 在输入框中处理。
import { XIcon } from 'lucide-react';

export function PromptSuggestionHint({ onAccept, onDismiss }: { onAccept(): void; onDismiss(): void }) {
  return <div className="flex items-center justify-between gap-2 text-ui-xs text-foreground-subtlest" role="status">
    <button type="button" className="min-w-0 text-left hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" aria-label="接受下一步建议为草稿" aria-keyshortcuts="Tab" onMouseDown={event => event.preventDefault()} onClick={onAccept}>下一步建议 · Tab 接受并编辑</button>
    <button type="button" className="shrink-0 rounded p-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" aria-label="忽略下一步建议" onMouseDown={event => event.preventDefault()} onClick={onDismiss}><XIcon className="size-3.5" /></button>
  </div>;
}
