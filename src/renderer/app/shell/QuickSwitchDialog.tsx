import { FolderIcon, LoaderIcon, MessageCircleIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import type { Project, SessionSummary } from "@hcode/shared/types";
import { AGENTS } from "@hcode/shared/agents";
import { hcode } from "../bridge";
import { shortenHome } from "../format";
import { useAppStore } from "../store/appStore";

type Result = { kind: "project"; project: Project } | { kind: "session"; session: SessionSummary };

export function QuickSwitchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const projects = useAppStore((state) => state.projects);
  const cachedSessions = useAppStore((state) => state.sessions);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setQuery("");
    setSelected(0);
    setSessions(Object.values(cachedSessions).flat());
    setLoading(true);
    void Promise.allSettled(projects.map((project) => hcode.invoke("sessions:list", project.path))).then((results) => {
      if (!active) return;
      const items = results.flatMap((result, index) => result.status === "fulfilled"
        ? result.value
        : cachedSessions[projects[index]!.path] ?? []);
      setSessions(items);
      setLoading(false);
    });
    return () => { active = false; };
    // The project list is captured when the dialog opens; store refreshes should not reset the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const results = useMemo<Result[]>(() => {
    const term = query.trim().toLocaleLowerCase();
    const matchingProjects = projects.filter((project) =>
      !term || project.name.toLocaleLowerCase().includes(term) || project.path.toLocaleLowerCase().includes(term),
    );
    const matchingSessions = sessions
      .filter((session) => !term || session.title.toLocaleLowerCase().includes(term) || session.projectPath.toLocaleLowerCase().includes(term))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, term ? 30 : 12);
    return [
      ...matchingProjects.map((project): Result => ({ kind: "project", project })),
      ...matchingSessions.map((session): Result => ({ kind: "session", session })),
    ];
  }, [projects, query, sessions]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, results]);

  const choose = (result: Result) => {
    onOpenChange(false);
    const state = useAppStore.getState();
    if (result.kind === "session") {
      void state.openSession(result.session);
      return;
    }
    state.toggleProject(result.project.path, true);
    const opened = Object.values(state.conversations).find((conv) => conv.projectPath === result.project.path);
    if (opened) state.activateView(opened.viewId);
    else if (result.project.purpose === "conversation") void state.workOutsideProject(true);
    else state.newChat(result.project.path);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(620px,85vh)] max-w-xl flex-col gap-0 p-0" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>快速切换</DialogTitle>
          <DialogDescription>搜索项目和会话</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />
          <input
            autoFocus
            aria-label="搜索项目或会话"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && results.length) {
                event.preventDefault();
                setSelected((value) => Math.min(value + 1, results.length - 1));
              } else if (event.key === "ArrowUp" && results.length) {
                event.preventDefault();
                setSelected((value) => Math.max(value - 1, 0));
              } else if (event.key === "Enter" && results[selected]) {
                event.preventDefault();
                choose(results[selected]);
              }
            }}
            placeholder="搜索项目或会话…"
            className="min-w-0 flex-1 bg-transparent text-ui-base outline-none placeholder:text-foreground-subtlest"
          />
          <kbd className="text-ui-xs text-foreground-subtlest">ESC</kbd>
        </div>
        <div ref={listRef} className="min-h-24 overflow-y-auto p-2" role="listbox" aria-label="快速切换结果">
          {results.length ? results.map((result, index) => (
            <button
              key={result.kind === "project" ? `project:${result.project.path}` : `session:${result.session.agent}:${result.session.id}`}
              type="button"
              role="option"
              aria-selected={index === selected}
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(result)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left outline-none hover:bg-surface-hover aria-selected:bg-selected focus-visible:ring-2 focus-visible:ring-ring"
            >
              {result.kind === "project" ? (
                <>{result.project.purpose === "conversation" ? <MessageCircleIcon className="size-4 shrink-0 text-foreground-subtle" /> : <FolderIcon className="size-4 shrink-0 text-foreground-subtle" />}<span className="min-w-0 flex-1 truncate text-ui-base">{result.project.name}</span><span className="max-w-48 truncate text-ui-xs text-foreground-subtlest">{result.project.purpose === "conversation" ? "不在项目中工作" : shortenHome(result.project.path)}</span></>
              ) : (
                <><span className="size-4 shrink-0 text-center text-ui-xs text-foreground-subtle">●</span><span className="min-w-0 flex-1 truncate text-ui-base">{result.session.title}</span><span className="max-w-48 truncate text-ui-xs text-foreground-subtlest">{AGENTS[result.session.agent].name} · {shortenHome(result.session.projectPath)}</span></>
              )}
            </button>
          )) : <p className="px-3 py-8 text-center text-ui-base text-foreground-subtle">{loading ? <><LoaderIcon className="mr-2 inline size-4 animate-spin" />正在读取会话…</> : "没有匹配的项目或会话"}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
