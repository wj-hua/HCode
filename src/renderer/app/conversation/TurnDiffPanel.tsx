import { ExternalLinkIcon, RefreshCwIcon, Undo2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { GitTurnFile, GitTurnPreview } from "@hcode/shared/types";
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
import { SidePanel } from "./SidePanel";

export function TurnDiffPanel({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const [recordId, setRecordId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; result: GitTurnPreview } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const record = conversation.turnHistory.find((item) => item.id === recordId)
    ?? (conversation.turnDiff === undefined ? conversation.turnHistory.at(-1) : undefined);
  const historical = !!record;
  const previews = record && preview?.id === record.id ? preview.result.files : [];
  const files: GitTurnFile[] = record
    ? record.files.map((file) => ({ ...file, patch: previews.find((item) => item.path === file.path)?.patch ?? null }))
    : conversation.turnDiff?.files ?? [];
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [revertPath, setRevertPath] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = record?.root ?? conversation.turnDiff?.root ?? conversation.projectPath;
  const running = useAppStore((state) => Object.values(state.conversations).some((item) => {
    const itemRoot = item.turnDiff?.root ?? item.projectPath;
    return (item.runState === "running" || item.runState === "awaitingApproval")
      && (itemRoot === root || itemRoot.startsWith(`${root}/`) || root.startsWith(`${itemRoot}/`));
  }));
  const disabled = pending || running || historical || !conversation.sessionKey || conversation.turnDiff === null;
  const lastUser = conversation.rows.findLast((row) => row.kind === "userInput");
  const firstUser = lastUser && conversation.rows.find((row) => row.kind === "userInput" && row.turnId === lastUser.turnId);
  const suggestion = (conversation.turnPrompt ?? (firstUser?.kind === "userInput" ? firstUser.text : "")).split(/\r?\n/)[0]?.trim() ?? "";
  const theme = useUiStore((state) => state.theme);
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];
  const lines = useMemo(() => selected?.patch ? getPlainTextPatchPreviewLines(selected.patch) : [], [selected?.patch]);
  const previewTheme = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
    ? DEFAULT_CODE_PREVIEW_SETTINGS.darkTheme
    : DEFAULT_CODE_PREVIEW_SETTINGS.lightTheme;

  useEffect(() => setSelectedPath(null), [conversation.viewId, conversation.turnDiff, record?.id]);
  useEffect(() => {
    setRecordId(null);
  }, [conversation.currentTurnId]);
  useEffect(() => {
    if (!record) return;
    let active = true;
    setLoadingPreview(true);
    setPreview(null);
    setPreviewError(null);
    void hcode.invoke("git:previewTurn", conversation.projectPath, record).then(
      (result) => { if (active) setPreview({ id: record.id, result }); },
      (failure) => { if (active) setPreviewError(errorMessage(failure)); },
    ).finally(() => { if (active) setLoadingPreview(false); });
    return () => { active = false; };
  }, [conversation.projectPath, record, previewRevision]);
  useEffect(() => {
    setChecked([]);
    setMessage("");
    setError(null);
    setRevertPath(null);
  }, [conversation.viewId, conversation.turnPrompt, record?.id]);
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
    <SidePanel
      label="改动面板"
      title={<>{historical ? "改动记录" : "本轮改动"} <span className="text-foreground-subtle">{files.length ? `· ${files.length} 个文件` : ""}</span></>}
      actions={<Button variant="ghost" size="icon-sm" disabled={historical ? loadingPreview : disabled || !conversation.turnDiff} onClick={() => historical ? setPreviewRevision((value) => value + 1) : void perform("refresh")} aria-label="刷新改动预览"><RefreshCwIcon /></Button>}
      onClose={onClose}
    >
      {conversation.turnHistory.length ? (
        <div className="shrink-0 border-b border-border px-4 py-2">
          <label className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
            轮次
            <select
              aria-label="改动轮次"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-foreground"
              value={record?.id ?? "current"}
              disabled={pending}
              onChange={(event) => setRecordId(event.target.value === "current" ? null : event.target.value)}
            >
              {conversation.turnDiff !== undefined ? <option value="current">当前改动</option> : null}
              {[...conversation.turnHistory].reverse().map((item) => (
                <option key={item.id} value={item.id}>{new Date(item.recordedAt).toLocaleString("zh-CN")} · {item.prompt || "文件改动"}（结束时）</option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {historical ? (
        <div className="shrink-0 space-y-1 border-b border-border px-4 py-2 text-ui-sm text-foreground-subtle" role="status">
          <p>历史记录仅供查看，文件清单和行数保留当时的记录。</p>
          {previews.some((file) => file.changed) ? <p className="text-warning">当前文件与当时不一致，预览显示相对该轮 HEAD 的当前差异。</p> : null}
          {previews.some((file) => file.baselineChanged) ? <p className="text-warning">发送前已有未提交内容，无法重建当时的逐行差异；预览基于该轮 HEAD。</p> : null}
          {previewError ? <p role="alert" className="break-words text-destructive">加载历史预览失败：{previewError}</p> : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="shrink-0 break-words border-b border-border px-4 py-2 text-ui-sm text-destructive">{error}</p> : null}
      {!historical && conversation.turnDiff === null ? (
        <p className="p-5 text-ui-sm text-foreground-subtle">正在记录本轮改动，运行结束后显示差异…</p>
      ) : !historical && conversation.turnDiff?.error ? (
        <p className="p-5 text-ui-sm text-destructive">读取改动失败：{conversation.turnDiff.error}</p>
      ) : !files.length ? (
        <p className="p-5 text-ui-sm text-foreground-subtle">{historical ? "该轮没有文件改动。" : conversation.turnDiff ? "本轮没有文件改动。" : "发送消息后，这里会显示本轮文件改动。"}</p>
      ) : (
        <>
          <div className="max-h-48 shrink-0 overflow-y-auto border-b border-border p-2">
            {files.map((file) => (
              <div
                key={file.path}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-ui-sm hover:bg-surface ${selected?.path === file.path ? "bg-surface" : ""}`}
              >
                {!historical ? <input
                  type="checkbox"
                  className="shrink-0 accent-primary"
                  aria-label={`提交 ${file.path}`}
                  disabled={disabled}
                  checked={checked.includes(file.path)}
                  onChange={(event) => setChecked((current) => event.target.checked ? [...current, file.path] : current.filter((path) => path !== file.path))}
                /> : null}
                <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left" onClick={() => setSelectedPath(file.path)}>
                  <span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>
                  <span className="shrink-0 text-diff-added">+{file.additions}</span>
                  <span className="shrink-0 text-diff-removed">−{file.deletions}</span>
                  {previews.find((item) => item.path === file.path)?.changed ? <span className="shrink-0 text-warning">已变化</span> : null}
                </button>
                {!historical ? <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 gap-1"
                  disabled={disabled || !!file.revertUnavailable}
                  title={file.revertUnavailable ?? "还原到本轮发送前"}
                  aria-label={`撤销 ${file.path}`}
                  onClick={() => { setError(null); setRevertPath(file.path); }}
                >
                  <Undo2Icon className="size-3.5" />撤销
                </Button> : null}
              </div>
            ))}
          </div>
          {selected ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2 text-ui-sm">
                <span className="min-w-0 truncate font-medium" title={selected.path}>{selected.path}</span>
                {selected.status !== "deleted" ? (
                  <Button variant="ghost" size="sm" className="shrink-0 gap-1" onClick={() => void hcode.invoke("app:openPath", `${root.replace(/\/$/, "")}/${selected.path}`)}>
                    <ExternalLinkIcon className="size-3.5" />在编辑器打开
                  </Button>
                ) : null}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {historical && loadingPreview ? (
                  <p className="p-4 text-ui-sm text-foreground-subtle">正在重建历史预览…</p>
                ) : selected.patch ? (
                  <HighlightedLightweightDiffPreview
                    codePreviewSettings={DEFAULT_CODE_PREVIEW_SETTINGS}
                    language={inferCodeLanguage(selected.path, selected.patch)}
                    lines={lines}
                    path={selected.path}
                    theme={previewTheme}
                  />
                ) : (
                  <p className="p-4 text-ui-sm text-foreground-subtle">{historical ? "当前无法显示该文件的行级差异，文件可能已还原、为二进制或超过预览大小限制。" : "该文件为二进制文件或超过预览大小限制，无法显示行级差异。"}</p>
                )}
              </div>
            </div>
          ) : null}
          {!historical ? <div className="shrink-0 space-y-2 border-t border-border p-3">
            <div className="flex items-center justify-between text-ui-sm">
              <label className="flex items-center gap-2"><input type="checkbox" className="accent-primary" disabled={disabled} checked={checked.length === files.length} onChange={(event) => setChecked(event.target.checked ? files.map((file) => file.path) : [])} />全选 · 已选 {checked.length} 个文件</label>
              <Button variant="ghost" size="sm" disabled={disabled || !suggestion} onClick={() => setMessage(suggestion)}>生成说明</Button>
            </div>
            <Textarea aria-label="提交说明" placeholder="填写提交说明" value={message} onChange={(event) => setMessage(event.target.value)} disabled={disabled} className="min-h-16 max-h-32 text-ui-sm" />
            <div className="flex items-center justify-between gap-3">
              <p className="text-ui-sm text-foreground-subtle">{running ? "该仓库有会话运行中，结束后可操作。" : "提交所选文件的全部未提交改动。"}</p>
              <Button size="sm" className="shrink-0" disabled={disabled || !checked.length || !message.trim()} onClick={() => void perform("commit")}>{pending ? "处理中…" : "提交"}</Button>
            </div>
          </div> : null}
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
    </SidePanel>
  );
}
