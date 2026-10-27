import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, FileDiffIcon, GitCommitHorizontalIcon, RefreshCwIcon } from "lucide-react";
import type { GitWorktree } from "@hcode/shared/types";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { BranchPicker } from "../composer/DraftContextBar";
import { hcode } from "../bridge";
import { useFilePreview } from "./FilePreviewContext";

export function GitTools({ workspacePath, running }: { workspacePath: string; running: boolean }) {
  const [git, setGit] = useState<GitWorktree | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [stageAll, setStageAll] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const preview = useFilePreview();
  const load = useCallback(async () => {
    try { setGit(await hcode.invoke("git:worktree", workspacePath)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [workspacePath]);
  useEffect(() => { setGit(null); void load(); }, [load]);
  useEffect(() => { if (!running) void load(); }, [load, running]);
  useEffect(() => { const refresh = () => void load(); window.addEventListener("focus", refresh); return () => window.removeEventListener("focus", refresh); }, [load]);
  if (!git) return null;
  const additions = git.files.reduce((n, file) => n + (file.additions ?? 0), 0);
  const deletions = git.files.reduce((n, file) => n + (file.deletions ?? 0), 0);
  const review = async (file: GitWorktree["files"][number]) => {
    const path = `${git.root}/${file.path}`;
    if (file.untracked) { preview?.onOpenFilePath(path); return; }
    try {
      const patch = await hcode.invoke("git:diff", git.root, file.path);
      if (patch) preview?.onOpenCodeViewer({ type: "patch", title: file.path.split("/").at(-1) ?? file.path, path, patch });
      else preview?.onOpenFilePath(path);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const action = async (kind: "commit" | "push") => {
    setPending(true); setError(null); setNotice(null);
    try {
      if (kind === "commit") { await hcode.invoke("git:commit", git.root, message, stageAll); setCommitOpen(false); setMessage(""); setStageAll(false); }
      else await hcode.invoke("git:push", git.root);
      setNotice(kind === "commit" ? "提交成功" : "推送成功");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { await load(); setPending(false); }
  };
  return <div className="rounded-2xl border border-border bg-background px-3 py-2 text-ui-base shadow-sm">
    <div className="flex items-center justify-between gap-3 px-1 text-foreground-subtle"><span>Git 工具</span><button type="button" onClick={() => void load()} aria-label="刷新 Git 状态" className="rounded p-1 hover:bg-muted"><RefreshCwIcon className="size-4" /></button></div>
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex h-9 w-full items-center gap-2 rounded-lg px-1 text-left hover:bg-muted"><FileDiffIcon className="size-4" /><span className="flex-1">更改 {git.files.length ? `(${git.files.length})` : ""}</span><span className="text-green-500">+{additions}</span><span className="text-red-500">−{deletions}</span><ChevronDownIcon className="size-3" /></button>
    {git.files.some(file => file.additions === null) ? <p className="px-1 text-ui-sm text-foreground-subtlest">新增、二进制或无法统计的文件未计入行数</p> : null}
    {open ? <div className="max-h-52 overflow-y-auto border-t border-border py-1">{git.files.length ? git.files.map(file => <button key={file.path} type="button" onClick={() => void review(file)} className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left hover:bg-muted"><span className="shrink-0 text-foreground-subtlest">{file.status.trim()}</span><span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>{file.additions !== null ? <span className="text-green-500">+{file.additions}</span> : null}{file.deletions !== null ? <span className="text-red-500">−{file.deletions}</span> : null}</button>) : <p className="px-1 py-2 text-foreground-subtlest">没有未提交的更改</p>}</div> : null}
    <BranchPicker projectPath={workspacePath} onChanged={() => void load()} />
    <div className="flex items-center gap-1"><button type="button" disabled={running || pending} onClick={() => { setError(null); setCommitOpen(true); }} className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-left hover:bg-muted disabled:opacity-50"><GitCommitHorizontalIcon className="size-4" />提交</button><button type="button" disabled={running || pending} onClick={() => void action("push")} className="rounded-lg px-2 py-1.5 hover:bg-muted disabled:opacity-50">推送</button></div>
    {notice ? <p role="status" className="px-1 text-ui-sm text-foreground-subtle">{notice}</p> : null}
    {error ? <p role="alert" className="break-words text-ui-sm text-destructive">{error}</p> : null}
    <Dialog open={commitOpen} onOpenChange={value => { if (!pending) setCommitOpen(value); }}><DialogContent><DialogHeader><DialogTitle>提交更改</DialogTitle><DialogDescription>默认提交已暂存的更改。选择下方选项会先暂存仓库中的所有更改。</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={event => { event.preventDefault(); void action("commit"); }}><textarea autoFocus aria-label="提交信息" value={message} onChange={event => setMessage(event.target.value)} className="min-h-24 w-full rounded-md border border-border bg-background p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="填写提交信息" /><label className="flex items-center gap-2"><input type="checkbox" checked={stageAll} onChange={event => setStageAll(event.target.checked)} />暂存所有更改后提交</label>{error ? <p role="alert" className="break-words text-ui-sm text-destructive">{error}</p> : null}<DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={() => setCommitOpen(false)}>取消</Button><Button type="submit" disabled={running || pending || !message.trim()}>{pending ? "提交中…" : "提交"}</Button></DialogFooter></form></DialogContent></Dialog>
  </div>;
}
