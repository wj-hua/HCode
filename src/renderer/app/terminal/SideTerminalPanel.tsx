import { useCallback, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { PanelResizeHandle } from "../conversation/PanelResizeHandle";
import { TerminalSession } from "../shell/TerminalPanel";
import { addTab, removeTab, type TerminalTabs } from "./terminalState";

/** 侧边标签拥有独立 PTY；隐藏面板或切换其他侧边内容时保持挂载。 */
export function SideTerminalPanel({ cwd, visible, onHide, onEmpty }: { cwd: string; visible: boolean; onHide: () => void; onEmpty: (cwd: string) => void }) {
  const [state, setState] = useState<TerminalTabs>(() => addTab());
  const current = useRef(state); current.current = state;
  const close = useCallback((id: string) => {
    const next = removeTab(current.current, id);
    if (!next) onEmpty(cwd);
    else { current.current = next; setState(next); }
  }, [cwd, onEmpty]);
  const project = cwd.split("/").filter(Boolean).at(-1) || "Terminal";
  return <aside aria-label="侧边终端" className="file-preview-side-panel relative min-h-0 shrink-0 flex-col border-l border-border bg-background" style={{ display: visible ? "flex" : "none" }}>
    <PanelResizeHandle docked label="调整侧边终端宽度" />
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
      <div role="tablist" aria-label="侧边终端标签" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {state.tabs.map(tab => { const label = tab.index === 1 ? project : `${project} ${tab.index}`; const active = state.active === tab.id; return <div key={tab.id} className={`group flex h-7 max-w-36 shrink-0 items-center gap-1 rounded-lg px-2 text-ui-base ${active ? "bg-selected text-foreground" : "text-foreground-subtle hover:bg-hover"}`}>
          <button role="tab" aria-selected={active} className="truncate" onClick={() => setState(value => ({ ...value, active: tab.id }))}>{label}</button>
          <button aria-label={`关闭侧边终端 ${label}`} className="rounded p-0.5 hover:bg-hover" onClick={() => close(tab.id)}><X className="size-3" /></button>
        </div>; })}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="新建侧边终端" title="新建侧边终端" onClick={() => setState(value => addTab(value))}><Plus /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="收起侧边终端" title="收起侧边终端" onClick={onHide}><X /></Button>
    </div>
    <div className="min-h-0 flex-1 overflow-hidden p-3">{state.tabs.map(tab => <TerminalSession key={tab.id} id={tab.id} cwd={cwd} visible={visible && state.active === tab.id} onExit={close} onShell={() => {}} />)}</div>
  </aside>;
}
