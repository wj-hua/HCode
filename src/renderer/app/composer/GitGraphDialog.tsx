import { useCallback, useEffect, useRef, useState } from "react";
import type { GitCommitGraphCommit } from "@zcode/shared";
import { LoaderIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { GitGraphPane } from "@/git-graph/GitGraphPane.js";
import { hcode } from "../bridge";
import { errorMessage } from "../store/appStore";

const PAGE_SIZE = 50;

export function GitGraphDialog({ open, projectPath, onOpenChange }: { open: boolean; projectPath: string; onOpenChange: (open: boolean) => void }) {
  const [commits, setCommits] = useState<GitCommitGraphCommit[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const busy = useRef(false);

  const load = useCallback(async (skip: number, kind: "initial" | "more" | "refresh") => {
    if (busy.current) return;
    busy.current = true;
    const id = ++request.current;
    if (kind === "initial") setLoading(true);
    else if (kind === "more") setLoadingMore(true);
    else setRefreshing(true);
    setError(null);
    try {
      const result = await hcode.invoke("git:graph", projectPath, PAGE_SIZE, skip);
      if (id !== request.current) return;
      setCommits((previous) => kind === "more" ? [...previous, ...result.commits] : result.commits);
      setHasMore(result.hasMore);
      if (kind !== "more") setSelected(result.commits[0]?.hash ?? null);
    } catch (cause) {
      if (id === request.current) setError(`Git 图谱加载失败：${errorMessage(cause)}`);
    } finally {
      if (id === request.current) {
        busy.current = false;
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    }
  }, [projectPath]);

  useEffect(() => {
    if (!open) return;
    setCommits([]);
    setSelected(null);
    setHasMore(false);
    busy.current = false;
    void load(0, "initial");
    return () => { request.current++; busy.current = false; };
  }, [open, load]);

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-[min(78dvh,720px)] w-[calc(100%-2rem)] min-h-0 max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:w-full">
      <DialogHeader className="sr-only"><DialogTitle>Git 图谱</DialogTitle><DialogDescription>查看当前仓库的提交历史。</DialogDescription></DialogHeader>
      {loading ? <div role="status" className="flex flex-1 items-center justify-center text-foreground-subtle"><LoaderIcon className="size-5 animate-spin" /><span className="sr-only">正在读取 Git 图谱</span></div> : error && commits.length === 0 ? <p role="alert" className="m-6 break-words text-ui-base text-destructive">{error}</p> : <>
        {error ? <p role="alert" className="shrink-0 break-words px-3 py-2 text-ui-base text-destructive">{error}</p> : null}
        <div className="min-h-0 flex-1"><GitGraphPane commits={commits} hasMore={hasMore} loadingMore={loadingMore} refreshing={refreshing} selectedCommitHash={selected} onSelectCommit={setSelected} onLoadMore={() => void load(commits.length, "more")} onRefresh={() => void load(0, "refresh")} /></div>
      </>}
    </DialogContent>
  </Dialog>;
}
