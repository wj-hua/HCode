// 单份冻结报告在模态层阅读；正文独立滚动，关闭后恢复触发入口的焦点。
import { useRef, type RefObject } from 'react';
import { FileTextIcon, XIcon } from 'lucide-react';
import type { InvokeMap } from '@hcode/shared/ipc';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.js';
import { FrozenReportView } from './FrozenReportView';

export function ExpertReportPreview({ report, claimId, reportLabel, reading, error, onClose, returnFocus }: {
  report?: InvokeMap['collaboration:artifact'][1];
  claimId?: string;
  reportLabel: string;
  reading: boolean;
  error: string;
  onClose(): void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  return <Dialog open={Boolean(reportLabel)} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent showCloseButton={false} overlayClassName="motion-reduce:animate-none" className="flex h-[90dvh] max-h-[48rem] w-[calc(100vw-2rem)] max-w-4xl min-w-0 flex-col gap-0 overflow-hidden p-0 motion-reduce:animate-none"
      // Portal 仍属于协作面板的 React 树；Esc 只关闭当前弹窗，不穿透到面板。
      onEscapeKeyDown={event => event.stopPropagation()}
      onOpenAutoFocus={event => {
        if (!returnFocus.current && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
        event.preventDefault();
        // 引用已定位到正文时保留选中结论的焦点；一般打开先读清来源，再进入正文。
        if (!report || !claimId) title.current?.focus();
      }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (returnFocus.current?.isConnected) returnFocus.current.focus();
        returnFocus.current = null;
      }}>
      <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
        <DialogHeader className="min-w-0 flex-1">
          <DialogTitle ref={title} tabIndex={-1} className="flex items-center gap-2 outline-none"><FileTextIcon aria-hidden className="size-4 shrink-0" />报告预览</DialogTitle>
          <DialogDescription className="break-words text-ui-sm">{reportLabel}</DialogDescription>
        </DialogHeader>
        <Button variant="ghost" size="icon-sm" aria-label="关闭报告预览" onClick={onClose}><XIcon /></Button>
      </header>
    <div role="region" aria-label="报告正文" aria-busy={reading} tabIndex={0} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
      {reading ? <p role="status" className="text-ui-sm">正在读取所选冻结报告…</p> : null}
      {error ? <p role="alert" className="whitespace-pre-wrap text-destructive">报告读取失败：{error}</p> : null}
      {report ? <FrozenReportView artifact={report} claimId={claimId} /> : null}
    </div>
    </DialogContent>
  </Dialog>;
}
