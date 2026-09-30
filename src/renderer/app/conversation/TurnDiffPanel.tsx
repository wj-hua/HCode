import { ExternalLinkIcon, RefreshCwIcon, Undo2Icon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { HighlightedLightweightDiffPreview } from "@/components/ui/highlighted-lightweight-diff-preview.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { inferCodeLanguage } from "@/lib/codeViewer.js";
import { getPlainTextPatchPreviewLines } from "@/lib/patchDiffPreview.js";
import { hcode } from "../bridge";
import { errorMessage, useAppStore, type Conversation } from "../store/appStore";
import { useUiStore } from "../store/uiStore";

export function TurnDiffPanel({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const files = conversation.turnDiff?.files ?? [];
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [revertPath, setRevertPath] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = conversation.turnDiff?.root ?? conversation.projectPath;
  const running = useAppStore((state) => Object.values(state.conversations).some((item) => {
    const itemRoot = item.turnDiff?.root ?? item.projectPath;
    return (item.runState === "running" || item.runState === "awaitingApproval")
      && (itemRoot === root || itemRoot.startsWith(`${root}/`) || root.startsWith(`${itemRoot}/`));
  }));
  const disabled = pending || running || !conversation.sessionKey || conversation.turnDiff === null;
  const lastUser = conversation.rows.findLast((row) => row.kind === "userInput");
  const firstUser = lastUser && conversation.rows.find((row) => row.kind === "userInput" && row.turnId === lastUser.turnId);
  const suggestion = (conversation.turnPrompt ?? (firstUser?.kind === "userInput" ? firstUser.text : "")).split(/\r?\n/)[0]?.trim() ?? "";
  const theme = useUiStore((state) => state.theme);
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];
  const lines = useMemo(() => selected?.patch ? getPlainTextPatchPreviewLines(selected.patch) : [], [selected?.patch]);
  const previewTheme = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
    ? DEFAULT_CODE_PREVIEW_SETTINGS.darkTheme
    : DEFAULT_CODE_PREVIEW_SETTINGS.lightTheme;

  useEffect(() => setSelectedPath(null), [conversation.viewId, conversation.turnDiff]);
  useEffect(() => {
    setChecked([]);
    setMessage("");
    setError(null);
    setRevertPath(null);
  }, [conversation.viewId, conversation.turnPrompt]);
  useEffect(() => {
    setChecked((current) => current.filter((path) => conversation.turnDiff?.files.some((file) => file.path === path)));
    if (conversation.turnDiff === null) {
      setMessage("");
      setError(null);
      setRevertPath(null);
    }
  }, [conversation.turnDiff]);

  const perform = async (action: "refresh" | "commit" | "revert", path?: string) => {
    if (disabled || !conversation.sessionKey) return;
    setPending(true);
    setError(null);
    try {
      if (action === "commit") {
        await hcode.invoke("git:commit", conversation.sessionKey, checked, message);
        setMessage("");
        toast("提交成功");
      } else if (action === "revert" && path) {
        await hcode.invoke("git:revertFile", conversation.sessionKey, path);
        setRevertPath(null);
        toast("已撤销该文件的本轮改动");
      } else {
        await hcode.invoke("git:refreshTurnDiff", conversation.sessionKey);
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <aside className="absolute inset-y-11 right-0 z-20 flex w-[min(560px,85%)] flex-col border-l border-border bg-background shadow-xl" aria-label="本轮改动">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="font-medium text-foreground">本轮改动 <span className="text-foreground-subtle">{files.length ? `· ${files.length} 个文件` : ""}</span></div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" disabled={disabled || !conversation.turnDiff} onClick={() => void perform("refresh")} aria-label="刷新本轮改动"><RefreshCwIcon /></Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭改动面板"><XIcon /></Button>
        </div>
      </div>
      {error ? <p role="alert" className="shrink-0 break-words border-b border-border px-4 py-2 text-ui-sm text-destructive">{error}</p> : null}
      {conversation.turnDiff === null ? (
        <p className="p-5 text-ui-sm text-foreground-subtle">正在记录本轮改动，运行结束后显示差异…</p>
      ) : conversation.turnDiff?.error ? (
        <p className="p-5 text-ui-sm text-destructive">读取改动失败：{conversation.turnDiff.error}</p>
      ) : !files.length ? (
        <p className="p-5 text-ui-sm text-foreground-subtle">{conversation.turnDiff ? "本轮没有文件改动。" : "发送消息后，这里会显示本轮文件改动。"}</p>
      ) : (
        <>
          <div className="max-h-48 shrink-0 overflow-y-auto border-b border-border p-2">
            {files.map((file) => (
              <div
                key={file.path}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-ui-sm hover:bg-surface ${selected?.path === file.path ? "bg-surface" : ""}`}
              >
                <input
                  type="checkbox"
                  className="shrink-0 accent-primary"
                  aria-label={`提交 ${file.path}`}
                  disabled={disabled}
                  checked={checked.includes(file.path)}
                  onChange={(event) => setChecked((current) => event.target.checked ? [...current, file.path] : current.filter((path) => path !== file.path))}
                />
                <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left" onClick={() => setSelectedPath(file.path)}>
                  <span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>
                  <span className="shrink-0 text-diff-added">+{file.additions}</span>
                  <span className="shrink-0 text-diff-removed">−{file.deletions}</span>
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 gap-1"
                  disabled={disabled || !!file.revertUnavailable}
                  title={file.revertUnavailable ?? "还原到本轮发送前"}
                  aria-label={`撤销 ${file.path}`}
                  onClick={() => { setError(null); setRevertPath(file.path); }}
                >
                  <Undo2Icon className="size-3.5" />撤销
                </Button>
              </div>
            ))}
          </div>
          {selected ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2 text-ui-sm">
                <span className="min-w-0 truncate font-medium" title={selected.path}>{selected.path}</span>
                {selected.status !== "deleted" ? (
                  <Button variant="ghost" size="sm" className="shrink-0 gap-1" onClick={() => void hcode.invoke("app:openPath", `${(conversation.turnDiff?.root ?? conversation.projectPath).replace(/\/$/, "")}/${selected.path}`)}>
                    <ExternalLinkIcon className="size-3.5" />在编辑器打开
                  </Button>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {selected.patch ? (
                  <HighlightedLightweightDiffPreview
                    codePreviewSettings={DEFAULT_CODE_PREVIEW_SETTINGS}
                    language={inferCodeLanguage(selected.path, selected.patch)}
                    lines={lines}
                    path={selected.path}
                    theme={previewTheme}
                  />
                ) : (
                  <p className="p-4 text-ui-sm text-foreground-subtle">该文件为二进制文件或超过预览大小限制，无法显示行级差异。</p>
                )}
              </div>
            </div>
          ) : null}
          <div className="shrink-0 space-y-2 border-t border-border p-3">
            <div className="flex items-center justify-between text-ui-sm">
              <label className="flex items-center gap-2"><input type="checkbox" className="accent-primary" disabled={disabled} checked={checked.length === files.length} onChange={(event) => setChecked(event.target.checked ? files.map((file) => file.path) : [])} />全选 · 已选 {checked.length} 个文件</label>
              <Button variant="ghost" size="sm" disabled={disabled || !suggestion} onClick={() => setMessage(suggestion)}>生成说明</Button>
            </div>
            <Textarea aria-label="提交说明" placeholder="填写提交说明" value={message} onChange={(event) => setMessage(event.target.value)} disabled={disabled} className="min-h-16 max-h-32 text-ui-sm" />
            <div className="flex items-center justify-between gap-3">
              <p className="text-ui-sm text-foreground-subtle">{running ? "该仓库有会话运行中，结束后可操作。" : "提交所选文件的全部未提交改动。"}</p>
              <Button size="sm" className="shrink-0" disabled={disabled || !checked.length || !message.trim()} onClick={() => void perform("commit")}>{pending ? "处理中…" : "提交"}</Button>
            </div>
          </div>
        </>
      )}
      <AlertDialog open={revertPath !== null} onOpenChange={(open) => { if (!open && !pending) setRevertPath(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤销本轮文件改动？</AlertDialogTitle>
            <AlertDialogDescription className="break-words">{revertPath}{"\n"}文件将还原到本轮发送前，保留发送前已有的改动。本轮新建的文件会移到废纸篓。</AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p role="alert" className="break-words text-ui-sm text-destructive">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={disabled} onClick={(event) => { event.preventDefault(); if (revertPath) void perform("revert", revertPath); }}>{pending ? "正在撤销…" : "撤销改动"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
