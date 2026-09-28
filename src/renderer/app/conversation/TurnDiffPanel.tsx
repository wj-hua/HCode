import { ExternalLinkIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { HighlightedLightweightDiffPreview } from "@/components/ui/highlighted-lightweight-diff-preview.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { inferCodeLanguage } from "@/lib/codeViewer.js";
import { getPlainTextPatchPreviewLines } from "@/lib/patchDiffPreview.js";
import { hcode } from "../bridge";
import type { Conversation } from "../store/appStore";
import { useUiStore } from "../store/uiStore";

export function TurnDiffPanel({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const files = conversation.turnDiff?.files ?? [];
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const theme = useUiStore((state) => state.theme);
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];
  const lines = useMemo(() => selected?.patch ? getPlainTextPatchPreviewLines(selected.patch) : [], [selected?.patch]);
  const previewTheme = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
    ? DEFAULT_CODE_PREVIEW_SETTINGS.darkTheme
    : DEFAULT_CODE_PREVIEW_SETTINGS.lightTheme;

  useEffect(() => setSelectedPath(null), [conversation.viewId, conversation.turnDiff]);

  return (
    <aside className="absolute inset-y-11 right-0 z-20 flex w-[min(560px,85%)] flex-col border-l border-border bg-background shadow-xl" aria-label="本轮改动">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="font-medium text-foreground">本轮改动 <span className="text-foreground-subtle">{files.length ? `· ${files.length} 个文件` : ""}</span></div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭改动面板"><XIcon /></Button>
      </div>
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
              <button
                key={file.path}
                type="button"
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm hover:bg-surface ${selected?.path === file.path ? "bg-surface" : ""}`}
                onClick={() => setSelectedPath(file.path)}
              >
                <span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>
                <span className="shrink-0 text-diff-added">+{file.additions}</span>
                <span className="shrink-0 text-diff-removed">−{file.deletions}</span>
              </button>
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
        </>
      )}
    </aside>
  );
}
