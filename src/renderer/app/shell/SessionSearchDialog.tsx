import { LoaderIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionSearchResult } from "@hcode/shared/types";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { AGENTS } from "@hcode/shared/agents";
import { hcode } from "../bridge";
import { shortenHome } from "../format";

const KIND_LABEL: Record<SessionSearchResult["kind"], string> = {
  title: "标题", user: "提问", assistant: "回复", reasoning: "思考", tool: "工具",
};

function Highlight({ text, query }: { text: string; query: string }) {
  const index = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  if (index < 0 || !query.trim()) return <>{text}</>;
  return <>{text.slice(0, index)}<mark className="rounded-sm bg-yellow-500/25 text-inherit">{text.slice(index, index + query.trim().length)}</mark>{text.slice(index + query.trim().length)}</>;
}

export function SessionSearchDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (result: SessionSearchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [results, selected]);

  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (!term) {
      setResults([]);
      setLoading(false);
      setError("");
      return;
    }
    let active = true;
    let started = false;
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => {
      started = true;
      void hcode.invoke("sessions:search", term).then(
        (matches) => {
          if (!active) return;
          setResults(matches);
          setSelected(0);
          setLoading(false);
        },
        (reason) => {
          if (!active) return;
          setError(reason instanceof Error ? reason.message : String(reason));
          setResults([]);
          setLoading(false);
        },
      );
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
      if (started) void hcode.invoke("sessions:search", "").catch(() => undefined);
    };
  }, [open, query]);

  const choose = (result: SessionSearchResult) => {
    onOpenChange(false);
    onSelect(result);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(640px,85vh)] max-w-2xl flex-col gap-3 p-0" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>搜索会话全文</DialogTitle>
          <DialogDescription>搜索所有 CLI 的会话标题和对话内容</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />
          <input
            autoFocus
            aria-label="搜索会话全文"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setResults([]);
              setLoading(Boolean(event.target.value.trim()));
              setSelected(0);
            }}
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
            placeholder="搜索会话标题、提问和回复…"
            className="min-w-0 flex-1 bg-transparent text-ui-base outline-none placeholder:text-foreground-subtlest"
          />
          <kbd className="text-ui-xs text-foreground-subtlest">ESC</kbd>
        </div>
        <div ref={listRef} className="min-h-24 overflow-y-auto px-2 pb-2" role="listbox" aria-label="搜索结果">
          {!query.trim() ? (
            <p className="px-3 py-8 text-center text-ui-base text-foreground-subtle">输入关键词搜索所有会话</p>
          ) : loading ? (
            <p className="flex items-center justify-center gap-2 px-3 py-8 text-ui-base text-foreground-subtle"><LoaderIcon className="size-4 animate-spin" />正在搜索…</p>
          ) : error ? (
            <p className="px-3 py-8 text-center text-ui-base text-destructive">搜索失败：{error}</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-8 text-center text-ui-base text-foreground-subtle">没有找到匹配的会话</p>
          ) : results.map((result, index) => (
            <button
              key={`${result.session.agent}:${result.session.id}:${result.rowId ?? "title"}:${index}`}
              type="button"
              role="option"
              aria-selected={index === selected}
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(result)}
              className="flex w-full flex-col gap-1 rounded-lg px-3 py-2 text-left outline-none hover:bg-surface-hover aria-selected:bg-selected focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex w-full items-center gap-2 text-ui-sm text-foreground-subtle">
                <span className="truncate font-medium text-foreground">{result.session.title}</span>
                <span className="shrink-0">{AGENTS[result.session.agent].name} · {KIND_LABEL[result.kind]}</span>
              </span>
              <span className="line-clamp-2 text-ui-base text-foreground"><Highlight text={result.snippet} query={query} /></span>
              <span className="truncate text-ui-xs text-foreground-subtlest">{shortenHome(result.session.projectPath)}</span>
            </button>
          ))}
          {results.length === 240 ? <p className="px-3 py-2 text-ui-xs text-foreground-subtlest">最多显示 240 条结果；输入更具体的关键词可缩小范围</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
