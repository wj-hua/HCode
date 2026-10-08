import type { ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";

export function SidePanel({ label, title, actions, onClose, children }: {
  label: string;
  title: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside className="absolute inset-y-11 right-0 z-20 flex w-[min(560px,85%)] flex-col border-l border-border bg-background shadow-xl" aria-label={label}>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <div className="min-w-0 truncate font-medium text-foreground">{title}</div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={`关闭${label}`}><XIcon /></Button>
        </div>
      </div>
      {children}
    </aside>
  );
}
