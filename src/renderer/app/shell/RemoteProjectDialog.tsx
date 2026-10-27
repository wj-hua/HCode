import { useEffect, useRef, useState } from "react";
import { FolderIcon, FolderSymlinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import type { ProjectDirectoryListing } from "@hcode/shared/ipc";
import { hcode } from "../bridge";
import { errorMessage, useAppStore } from "../store/appStore";

export function RemoteProjectDialog() {
  const open = useAppStore((state) => state.remoteProjectDialogOpen);
  const setOpen = useAppStore((state) => state.setRemoteProjectDialogOpen);
  const [listing, setListing] = useState<ProjectDirectoryListing | null>(null);
  const [inputPath, setInputPath] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [create, setCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState(false);
  const origin = useRef<string | null>(null);
  const requestId = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const navigate = async (path: string | null, hidden: boolean) => {
    const request = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await hcode.invoke("projects:browseDirectories", path, hidden);
      if (request !== requestId.current) return;
      setListing(result);
      setInputPath(result.path);
      setNavigationError(false);
      listRef.current?.scrollTo(0, 0);
    } catch (cause) {
      if (request !== requestId.current) return;
      setNavigationError(true);
      setError(`无法读取目录：${errorMessage(cause)}`);
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    origin.current = useAppStore.getState().activeViewId;
    setListing(null);
    setInputPath("");
    setShowHidden(false);
    setCreate(false);
    setError(null);
    setNavigationError(false);
    void navigate(null, false);
    // 弹窗关闭或重新打开时，丢弃迟到的目录响应。
    return () => { requestId.current++; };
  }, [open]);

  const submit = async () => {
    const path = create ? inputPath.trim() : listing?.path;
    if (pending || loading || !path || (!create && navigationError) || (create && path === listing?.path)) return;
    setPending(true);
    setError(null);
    try {
      const project = await hcode.invoke("projects:addPath", path, create);
      await useAppStore.getState().refreshProjects();
      const state = useAppStore.getState();
      state.toggleProject(project.path, true);
      // 保存期间若用户切换了会话，只刷新项目列表，不抢走当前界面。
      if (state.activeViewId === origin.current) {
        const conversation = state.activeViewId ? state.conversations[state.activeViewId] : undefined;
        if (conversation && !conversation.sessionKey && !conversation.sessionId && !conversation.compareId) state.setDraftProject(project.path);
        else state.newChat(project.path);
      }
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  const canSubmit = create
    ? Boolean(inputPath.trim() && inputPath.trim() !== listing?.path)
    : Boolean(listing && !navigationError);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next); }}>
      <DialogContent
        ref={contentRef}
        className="flex h-[min(38rem,calc(100dvh-2rem))] min-h-0 flex-col gap-4 sm:max-w-xl"
        onOpenAutoFocus={(event) => { event.preventDefault(); contentRef.current?.focus(); }}
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>选择文件夹</DialogTitle>
          <DialogDescription className="sr-only">浏览运行 HCode 的电脑上的文件夹，选择当前目录作为项目。</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 rounded-lg border border-border bg-surface p-3">
          <form className="flex shrink-0 flex-col gap-2 sm:flex-row" onSubmit={(event) => {
            event.preventDefault();
            if (inputPath.trim()) void navigate(inputPath.trim(), showHidden);
          }}>
            <Input
              size="lg"
              aria-label="电脑上的目录路径"
              placeholder="输入路径"
              value={inputPath}
              disabled={pending}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              className="h-10 min-w-0 flex-1 font-mono max-md:text-mobile-input-safe"
              onChange={(event) => setInputPath(event.target.value)}
            />
            <div className="flex gap-2 sm:shrink-0">
              <Button type="submit" variant="secondary" size="lg" className="h-10 flex-1 px-4 sm:flex-none" disabled={pending || !inputPath.trim()}>跳转</Button>
              <Button type="button" variant={showHidden ? "secondary" : "ghost"} size="lg" className="h-10 flex-1 px-3 sm:flex-none" aria-pressed={showHidden} disabled={pending} onClick={() => {
                const next = !showHidden;
                setShowHidden(next);
                void navigate(listing?.path ?? null, next);
              }}>{showHidden ? "收起隐藏目录" : "显示隐藏目录"}</Button>
            </div>
          </form>
          {error ? <p role="alert" className="shrink-0 break-words text-ui-sm text-destructive">{error}</p> : null}
          <div ref={listRef} aria-label="文件夹列表" aria-busy={loading} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain rounded-md bg-background">
            {listing?.parent ? <button type="button" disabled={pending} onClick={() => void navigate(listing.parent, showHidden)} className="flex h-10 w-full shrink-0 items-center gap-2 px-3 text-left text-ui-base active:bg-hover/50 hover:bg-hover/50">
              <FolderIcon aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" /><span>..</span><span className="sr-only">返回上级目录</span>
            </button> : null}
            {loading ? <p role="status" className="p-4 text-center text-ui-base text-foreground-subtle">正在读取文件夹…</p> : listing?.directories.length ? listing.directories.map((directory) => {
              const Icon = directory.isSymbolicLink ? FolderSymlinkIcon : FolderIcon;
              return <button key={directory.path} type="button" disabled={pending} onClick={() => void navigate(directory.path, showHidden)} className="flex h-10 w-full shrink-0 items-center gap-2 px-3 text-left text-ui-base active:bg-hover/50 hover:bg-hover/50">
                <Icon aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" /><span className="truncate">{directory.name}</span>
              </button>;
            }) : listing ? <p className="p-4 text-center text-ui-base text-foreground-subtle">无子目录</p> : null}
          </div>
        </div>
        {create ? <p className="shrink-0 text-ui-sm text-foreground-subtle">在上方输入新文件夹的完整路径，父目录必须已存在。</p> : null}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <label className="mr-auto flex min-h-10 items-center gap-2 text-ui-base"><input type="checkbox" checked={create} disabled={pending} onChange={(event) => setCreate(event.target.checked)} />新建文件夹</label>
          <Button type="button" variant="secondary" size="lg" className="h-10 px-4" disabled={pending} onClick={() => setOpen(false)}>取消</Button>
          <Button type="button" size="lg" className="h-10 px-4" disabled={pending || loading || !canSubmit} onClick={() => void submit()}>{pending ? "添加中…" : create ? "新建并添加" : "选择文件夹"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
