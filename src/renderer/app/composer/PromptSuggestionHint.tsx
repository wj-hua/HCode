// 原生建议只可显式接受为草稿；按钮不提交表单，键盘接受键在输入框中处理，手机窄屏提示点按或回车。
import { XIcon } from 'lucide-react';

export function PromptSuggestionHint({ narrow, onAccept, onDismiss }: { narrow: boolean; onAccept(): void; onDismiss(): void }) {
  return <div className="flex items-center justify-between gap-2 text-ui-xs text-foreground-subtlest" role="status">
    <button type="button" className="min-w-0 text-left hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" aria-label="接受下一步建议为草稿" aria-keyshortcuts={narrow ? 'Enter' : 'Tab ArrowRight'} onMouseDown={event => event.preventDefault()} onClick={onAccept}>{narrow ? '下一步建议 · 点按或回车填入' : '下一步建议 · Tab 或 → 接受并编辑'}</button>
    <button type="button" className="shrink-0 rounded p-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" aria-label="忽略下一步建议" onMouseDown={event => event.preventDefault()} onClick={onDismiss}><XIcon className="size-3.5" /></button>
  </div>;
}
