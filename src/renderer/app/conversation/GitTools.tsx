import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpFromLineIcon,
  ChevronDownIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import type { GitWorktree } from "@hcode/shared/types";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { BranchPicker } from "../composer/DraftContextBar";
import { hcode } from "../bridge";
import { useFilePreview } from "./FilePreviewContext";

function splitFilePath(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf("/");
  return index >= 0 ? { name: path.slice(index + 1), dir: path.slice(0, index) } : { name: path, dir: "" };
}

function statusTone(status: string): string {
  const code = status.trim();
  if (code === "??" || code.includes("A")) return "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400";
  if (code.includes("D")) return "bg-rose-500/12 text-rose-600 dark:text-rose-400";
  if (code.includes("M")) return "bg-amber-500/12 text-amber-600 dark:text-amber-400";
  return "bg-foreground/8 text-foreground-subtle";
}

export function GitTools({ workspacePath, running }: { workspacePath: string; running: boolean }) {
  const [git, setGit] = useState<GitWorktree | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [stageAll, setStageAll] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const preview = useFilePreview();

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      setGit(await hcode.invoke("git:worktree", workspacePath));
      if (manual) setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (manual) setRefreshing(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    setGit(null);
    setExpanded(false);
    setNotice(null);
    setError(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!running) void load();
  }, [load, running]);

  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (event: PointerEvent) => {
      if (commitOpen) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (containerRef.current?.contains(target)) return;
      if (target.closest('[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"]')) return;
      setExpanded(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || commitOpen) return;
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"]')) return;
      setExpanded(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded, commitOpen]);

  if (!git) return null;

  const dirtyCount = git.files.length;
  const additions = git.files.reduce((n, file) => n + (file.additions ?? 0), 0);
  const deletions = git.files.reduce((n, file) => n + (file.deletions ?? 0), 0);
  const branchLabel = git.branch ?? "HEAD";

  const review = async (file: GitWorktree["files"][number]) => {
    const path = `${git.root}/${file.path}`;
    if (file.untracked) {
      preview?.onOpenFilePath(path);
      return;
    }
    try {
      const patch = await hcode.invoke("git:diff", git.root, file.path);
      if (patch) preview?.onOpenCodeViewer({ type: "patch", title: file.path.split("/").at(-1) ?? file.path, path, patch });
      else preview?.onOpenFilePath(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const action = async (kind: "commit" | "push") => {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      if (kind === "commit") {
        await hcode.invoke("git:commit", git.root, message, stageAll);
        setCommitOpen(false);
        setMessage("");
        setStageAll(false);
        setNotice("提交成功");
      } else {
        setNotice(await hcode.invoke("git:push", git.root) ? "推送成功" : "远程已是最新，没有需要推送的提交");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      await load();
      setPending(false);
    }
  };

  return (
    <div ref={containerRef} className="relative inline-flex max-w-full flex-col items-end">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Git 工具（${branchLabel}${dirtyCount ? `，${dirtyCount} 个更改` : ""}）`}
        onClick={() => {
          const next = !expanded;
          setExpanded(next);
          if (next) void load();
        }}
        className={cn(
          "inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border px-3 text-ui-sm shadow-xs transition-colors",
          expanded
            ? "border-border bg-menu/95 text-foreground"
            : "border-border/75 bg-background/85 text-foreground-subtle hover:border-border hover:bg-background/95 hover:text-foreground",
        )}
      >
        <GitBranchIcon className="size-3.5 shrink-0" />
        <span className="max-w-32 truncate font-medium text-foreground">{branchLabel}</span>
        {dirtyCount > 0 ? (
          <>
            <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[11px] font-medium tabular-nums leading-none text-foreground">
              {dirtyCount}
            </span>
            {additions > 0 || deletions > 0 ? (
              <span className="flex items-center gap-1 text-ui-xs tabular-nums">
                {additions > 0 ? <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span> : null}
                {deletions > 0 ? <span className="text-rose-600 dark:text-rose-400">−{deletions}</span> : null}
              </span>
            ) : null}
          </>
        ) : null}
        {!expanded && (error || notice) ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", error ? "bg-destructive" : "bg-emerald-500")} />
        ) : null}
        <ChevronDownIcon className={cn("size-3.5 shrink-0 text-foreground-subtlest transition-transform duration-150", expanded && "rotate-180")} />
      </button>

      {expanded ? (
        <div className="absolute top-full right-0 z-20 mt-1.5 w-76 max-w-[calc(100vw-1.5rem)] rounded-2xl border border-border/80 bg-menu/95 p-3 text-ui-base text-foreground shadow-lg">
          <div className="flex items-center justify-between gap-2 pb-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-ui-sm font-medium text-foreground">Git 工具</span>
              <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] text-foreground-subtle">
                {dirtyCount ? `${dirtyCount} 项更改` : "工作区干净"}
              </span>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => void load(true)}
                aria-label="刷新 Git 状态"
                className="rounded-md p-1 text-foreground-subtle transition-colors hover:bg-menu-hover hover:text-foreground"
              >
                <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
              </button>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                aria-label="收起 Git 工具"
                className="rounded-md p-1 text-foreground-subtle transition-colors hover:bg-menu-hover hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-surface/60 px-2 py-1">
            <span className="shrink-0 pl-1 text-ui-xs text-foreground-subtle">分支</span>
            <BranchPicker projectPath={workspacePath} onChanged={() => void load()} />
          </div>

          <div className="mt-2.5">
            <div className="flex items-center justify-between px-1 pb-1.5 text-ui-xs text-foreground-subtle">
              <span className="flex items-center gap-1.5">
                <FileDiffIcon className="size-3.5" />
                <span>更改文件{dirtyCount ? ` (${dirtyCount})` : ""}</span>
              </span>
              {dirtyCount > 0 ? (
                <span className="flex items-center gap-1.5 tabular-nums">
                  <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
                  <span className="text-rose-600 dark:text-rose-400">−{deletions}</span>
                </span>
              ) : null}
            </div>

            {dirtyCount > 0 ? (
              <div className="max-h-52 space-y-0.5 overflow-y-auto overscroll-contain pr-0.5">
                {git.files.map((file) => {
                  const { name, dir } = splitFilePath(file.path);
                  return (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => void review(file)}
                      title={file.path}
                      className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-menu-hover"
                    >
                      <span className={cn("w-5 shrink-0 rounded px-1 py-0.5 text-center font-mono text-[10px] font-medium leading-none", statusTone(file.status))}>
                        {file.status.trim()}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ui-sm">
                        <span className="text-foreground">{name}</span>
                        {dir ? <span className="ml-1.5 text-ui-xs text-foreground-subtlest">{dir}</span> : null}
                      </span>
                      {file.additions !== null || file.deletions !== null ? (
                        <span className="flex shrink-0 items-center gap-1 text-ui-xs tabular-nums">
                          {file.additions !== null ? <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span> : null}
                          {file.deletions !== null ? <span className="text-rose-600 dark:text-rose-400">−{file.deletions}</span> : null}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border/60 px-3 py-3 text-center text-ui-xs text-foreground-subtlest">
                没有未提交的更改
              </div>
            )}
            {git.files.some((file) => file.additions === null) ? (
              <p className="px-1 pt-1 text-[11px] text-foreground-subtlest">新增、二进制或无法统计的文件未计入行数</p>
            ) : null}
          </div>

          <div className="mt-2.5 flex items-center gap-2 border-t border-border/60 pt-2.5">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={running || pending}
              onClick={() => {
                setError(null);
                setCommitOpen(true);
              }}
              className="flex-1 gap-1.5 rounded-lg"
            >
              <GitCommitHorizontalIcon className="size-3.5" />
              <span>提交</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={running || pending}
              onClick={() => void action("push")}
              className="gap-1.5 rounded-lg"
            >
              <ArrowUpFromLineIcon className="size-3.5" />
              <span>{pending ? "处理中…" : "推送"}</span>
            </Button>
          </div>

          {notice ? (
            <p role="status" className="mt-2 rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-ui-xs text-emerald-600 dark:text-emerald-400">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-2 break-words rounded-lg bg-destructive/10 px-2.5 py-1.5 text-ui-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      <Dialog open={commitOpen} onOpenChange={(value) => { if (!pending) setCommitOpen(value); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>提交更改</DialogTitle>
            <DialogDescription>默认提交已暂存的更改。选择下方选项会先暂存仓库中的所有更改。</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void action("commit"); }}>
            <textarea
              autoFocus
              aria-label="提交信息"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              className="min-h-24 w-full rounded-md border border-border bg-background p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="填写提交信息"
            />
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={stageAll} onChange={(event) => setStageAll(event.target.checked)} />
              暂存所有更改后提交
            </label>
            {error ? <p role="alert" className="break-words text-ui-sm text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setCommitOpen(false)}>取消</Button>
              <Button type="submit" disabled={running || pending || !message.trim()}>{pending ? "提交中…" : "提交"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
