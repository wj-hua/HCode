import { PanelResizeHandle } from "./PanelResizeHandle";
import { useEffect, useRef, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { useUiStore } from "../store/uiStore";
import { Button } from "@/components/ui/button.js";

export function SidePanel({ label, title, actions, onClose, children, focus = false, collaboration = false }: {
  label: string;
  title: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  focus?: boolean;
  collaboration?: boolean;
}) {
  const header = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) header.current?.focus(); }, [focus]);
  const returnPanel = useUiStore(state => state.returnPanel);
  const setSidePanel = useUiStore(state => state.setSidePanel);
  return (
    <aside onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }} className={`absolute inset-y-11 right-0 z-20 flex w-[min(560px,85%)] flex-col border-l border-border bg-background shadow-xl ${collaboration ? "collaboration-side-panel" : ""}`} aria-label={label}>
      {collaboration ? <PanelResizeHandle /> : null}
      <div ref={header} tabIndex={-1} className="outline-none flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <div className="min-w-0 truncate font-medium text-foreground">{title}</div>
        <div className="flex shrink-0 items-center gap-1">
          {returnPanel ? <Button variant="ghost" size="sm" onClick={() => setSidePanel(returnPanel)}>返回协作任务</Button> : null}
          {actions}
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={`关闭${label}`}><XIcon /></Button>
        </div>
      </div>
      {children}
    </aside>
  );
}
