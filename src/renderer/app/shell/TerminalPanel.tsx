import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import "@xterm/xterm/css/xterm.css";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { hcode } from "../bridge";
import { addTab, removeTab, type TerminalTabs } from "../terminal/terminalState";
import { mergeTerminalTheme } from "../terminal/terminalTheme";
import { getHttpLinksForTerminalBufferLine } from "../terminal/terminalLinks";

export function TerminalSession({ id, cwd, visible, onExit, onShell }: { id: string; cwd: string; visible: boolean; onExit: (id: string) => void; onShell: (id: string, shell: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const resize = useRef<() => void>(() => {});
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const shellRef = useRef(onShell);
  shellRef.current = onShell;
  const [error, setError] = useState("");
  useEffect(() => {
    if (!container.current) return;
    const terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace", scrollback: 5000, theme: mergeTerminalTheme(undefined), linkHandler: { activate(event, uri) { if (/^https?:\/\//i.test(uri)) { event.preventDefault(); void hcode.invoke("app:openExternal", uri); } } } });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new ClipboardAddon());
    terminal.open(container.current);
    let started = false;
    let disposed = false;
    const updateSize = () => {
      if (!container.current?.clientWidth || !container.current.clientHeight) return;
      fit.fit();
      if (started) void hcode.invoke("terminal:resize", id, terminal.cols, terminal.rows);
    };
    resize.current = updateSize;
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container.current);
    const themeObserver = new MutationObserver(() => { terminal.options.theme = mergeTerminalTheme(undefined); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== "keydown" || !(event.metaKey || event.ctrlKey)) return true;
      const key = event.key.toLowerCase();
      if (key === "c" && terminal.hasSelection()) {
        event.preventDefault();
        void navigator.clipboard.writeText(terminal.getSelection());
        return false;
      }
      if (key === "v") {
        event.preventDefault(); event.stopPropagation();
        void navigator.clipboard.readText().then(text => { if (text) terminal.paste(text); });
        return false;
      }
      return true;
    });
    const links = terminal.registerLinkProvider({ provideLinks(line, callback) {
      callback(getHttpLinksForTerminalBufferLine(terminal.buffer.active, line, terminal.cols)?.map((link): ILink => ({
        ...link, activate(event, text) { event.preventDefault(); void hcode.invoke("app:openExternal", text); },
      })));
    } });
    const off = hcode.on("terminal:event", event => {
      if (event.id !== id) return;
      if (event.data !== undefined) terminal.write(event.data);
      if (event.exitCode !== undefined) exitRef.current(id);
    });
    const input = terminal.onData(data => { if (started) void hcode.invoke("terminal:write", id, data); });
    const start = hcode.invoke("terminal:create", id, cwd, terminal.cols, terminal.rows).then(shell => {
      started = true;
      if (!disposed) { shellRef.current(id, shell); updateSize(); }
    }).catch(reason => { if (!disposed) setError(String(reason)); });
    return () => {
      disposed = true;
      observer.disconnect(); themeObserver.disconnect(); off(); input.dispose(); links.dispose(); terminal.dispose(); terminalRef.current = null;
      void start.then(() => hcode.invoke("terminal:close", id));
    };
  }, [cwd, id]);
  useEffect(() => { if (visible) requestAnimationFrame(() => { resize.current(); terminalRef.current?.focus(); }); }, [visible]);
  return <div className="h-full min-h-0" style={{ display: visible ? undefined : "none" }}>
    {error ? <p role="alert" className="text-sm text-destructive">终端启动失败：{error}</p> : null}
    <ContextMenu><ContextMenuTrigger asChild><div ref={container} className="h-full min-h-0" /></ContextMenuTrigger><ContextMenuContent>
      <ContextMenuItem onSelect={() => { const term = terminalRef.current; if (term?.hasSelection()) void navigator.clipboard.writeText(term.getSelection()); }}>复制</ContextMenuItem>
      <ContextMenuItem onSelect={() => { void navigator.clipboard.readText().then(text => { if (text) terminalRef.current?.paste(text); }); }}>粘贴</ContextMenuItem>
    </ContextMenuContent></ContextMenu>
  </div>;
}

export function TerminalPanel({ cwd, visible, height, onHide, onEmpty }: { cwd: string; visible: boolean; height: number; onHide: () => void; onEmpty: (cwd: string) => void }) {
  const [state, setState] = useState<TerminalTabs>(() => addTab());
  const stateRef = useRef(state); stateRef.current = state;
  const handleExit = useCallback((id: string) => {
    const next = removeTab(stateRef.current, id);
    if (!next) onEmpty(cwd); else { stateRef.current = next; setState(next); }
  }, [cwd, onEmpty]);
  const closeTab = (id: string) => {
    if (state.tabs.length === 1) { onHide(); return; }
    const next = removeTab(state, id);
    if (next) setState(next);
  };
  const projectName = cwd.split("/").filter(Boolean).at(-1) || "终端";
  return <section aria-label="内置终端" className="flex min-h-0 shrink-0 flex-col gap-2 overflow-hidden border-t border-border bg-background p-3 pb-2" style={{ display: visible ? undefined : "none", height, maxHeight: "50%" }}>
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-ui-base font-medium">终端</span>
      {state.tabs.find(tab => tab.id === state.active)?.shell ? <span className="text-ui-base text-foreground-subtle">{state.tabs.find(tab => tab.id === state.active)?.shell}</span> : null}
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist" aria-label="终端标签">
        {state.tabs.map(tab => { const label = tab.index === 1 ? projectName : `${projectName} ${tab.index}`; const active = tab.id === state.active; return <div key={tab.id} className={`group flex h-7 max-w-36 shrink-0 items-center gap-1 rounded-lg px-2 text-ui-base ${active ? "bg-selected text-foreground" : "text-foreground-subtle hover:bg-hover"}`}>
          <button role="tab" aria-selected={active} className="truncate" onClick={() => setState(current => ({ ...current, active: tab.id }))}>{label}</button>
          <button aria-label={`关闭终端 ${label}`} className="rounded p-0.5 hover:bg-hover" onClick={() => closeTab(tab.id)}><X className="size-3" /></button>
        </div>; })}
      </div>
      <Button variant="ghost" size="icon-md" aria-label="新建终端" title="新建终端" onClick={() => setState(current => addTab(current))}><Plus /></Button>
      <Button variant="ghost" size="icon-md" aria-label="收起终端面板" title="收起终端面板" onClick={onHide}><X /></Button>
    </div>
    <div className="min-h-0 flex-1">{state.tabs.map(tab => <TerminalSession key={tab.id} id={tab.id} cwd={cwd} visible={visible && tab.id === state.active} onExit={handleExit} onShell={(id, shell) => setState(current => ({ ...current, tabs: current.tabs.map(item => item.id === id ? { ...item, shell } : item) }))} />)}</div>
  </section>;
}
