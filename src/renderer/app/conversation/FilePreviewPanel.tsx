import { ExternalLinkIcon, FileCodeIcon, FolderOpenIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { CodeViewer } from "@/components/ui/code-viewer.js";
import { HighlightedLightweightDiffPreview } from "@/components/ui/highlighted-lightweight-diff-preview.js";
import { FILE_VIEWER_MAX_TEXT_BYTES, buildUnifiedDiff, inferCodeLanguage, type CodeViewerSource } from "@/lib/codeViewer.js";
import { getPlainTextPatchPreviewLines } from "@/lib/patchDiffPreview.js";
import { hcode } from "../bridge";
import { errorMessage } from "../store/appStore";
import { useUiStore } from "../store/uiStore";
import { SidePanel } from "./SidePanel";

type FileResult = { content: string; notice?: never } | { notice: string; content?: never };

export function FilePreviewPanel({ source, onClose, onViewFile }: {
  source: CodeViewerSource;
  onClose: () => void;
  onViewFile: () => void;
}) {
  const [result, setResult] = useState<FileResult | null>(null);
  const [revision, setRevision] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const settings = useUiStore((state) => state.codePreviewSettings);
  const theme = useUiStore((state) => state.theme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const dark = theme === "dark" || theme === "zai-dark" || (theme === "system" && systemDark);
  const previewTheme = dark ? settings.darkTheme : settings.lightTheme;
  const path = source.path;
  const patch = useMemo(() => source.type === "patch" ? source.patch
    : source.type === "multi-file-diff" ? buildUnifiedDiff(source.beforeContent, source.afterContent, source.title) : null, [source]);
  const inlineTooLarge = useMemo(() => {
    const text = source.type === "text" ? source.content : patch;
    return text ? new TextEncoder().encode(text).byteLength > FILE_VIEWER_MAX_TEXT_BYTES : false;
  }, [source, patch]);
  const lines = useMemo(() => patch ? getPlainTextPatchPreviewLines(patch) : [], [patch]);
  const readsFile = source.type !== "text" && source.type !== "patch" && source.type !== "multi-file-diff";

  useEffect(() => {
    setActionError(null);
    if (!readsFile || !path) return;
    let active = true;
    setResult(null);
    const load = async (): Promise<FileResult> => {
      const info = await hcode.invoke("fs:stat", path);
      if (!info?.exists) return { notice: "文件不存在或无法访问，可能已移动或删除。" };
      if (info.isDirectory) return { notice: "这是一个文件夹，请在 Finder 中查看。" };
      if (info.size > FILE_VIEWER_MAX_TEXT_BYTES) return { notice: "文件超过 256 KiB 预览上限，请用默认应用打开。" };
      const content = await hcode.invoke("fs:readText", path, FILE_VIEWER_MAX_TEXT_BYTES);
      return content === null
        ? { notice: "该文件为二进制、非 UTF-8 文本或无法读取，请用默认应用打开。" }
        : { content };
    };
    void load().then(
      (value) => { if (active) setResult(value); },
      (error) => { if (active) setResult({ notice: `读取文件失败：${errorMessage(error)}` }); },
    );
    return () => { active = false; };
  }, [source, path, readsFile, revision]);

  const perform = async (channel: "app:showInFinder" | "app:openPath") => {
    if (!path) return;
    setActionError(null);
    try {
      await hcode.invoke(channel, path);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };
  const content = source.type === "text" ? source.content : result?.content;
  const language = source.type === "text" ? source.language : inferCodeLanguage(path, content);

  return (
    <SidePanel
      label="文件预览面板"
      title={<span title={path ?? source.title}>{source.title}</span>}
      onClose={onClose}
      actions={readsFile && path ? <Button variant="ghost" size="icon-sm" onClick={() => setRevision((value) => value + 1)} aria-label="刷新文件预览"><RefreshCwIcon /></Button> : null}
    >
      {path ? (
        <div className="shrink-0 space-y-2 border-b border-border px-4 py-2">
          <p className="truncate font-mono text-ui-sm text-foreground-subtle" title={path}>{path}</p>
          <div className="flex flex-wrap gap-1">
            {!readsFile ? <Button variant="ghost" size="sm" className="gap-1" onClick={onViewFile}><FileCodeIcon className="size-3.5" />查看文件内容</Button> : null}
            <Button variant="ghost" size="sm" className="gap-1" onClick={() => void perform("app:showInFinder")}><FolderOpenIcon className="size-3.5" />在 Finder 显示</Button>
            <Button variant="ghost" size="sm" className="gap-1" onClick={() => void perform("app:openPath")}><ExternalLinkIcon className="size-3.5" />用默认应用打开</Button>
          </div>
        </div>
      ) : null}
      {actionError ? <p role="alert" className="shrink-0 break-words px-4 py-2 text-ui-sm text-destructive">打开失败：{actionError}</p> : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {inlineTooLarge ? (
          <p role="status" className="p-4 text-ui-sm text-foreground-subtle">工具内容超过 256 KiB 预览上限。{path ? "请用默认应用打开文件。" : "请在工具卡片中查看。"}</p>
        ) : patch ? (
          <HighlightedLightweightDiffPreview codePreviewSettings={settings} language={inferCodeLanguage(path)} lines={lines} path={path} theme={previewTheme} />
        ) : content !== undefined ? (
          content.length ? <CodeViewer code={content} language={language} theme={previewTheme} showLineNumbers={settings.showLineNumbers} wrapLongLines={settings.wrapLongLines} fontSizePx={settings.fontSizePx} />
            : <p role="status" className="p-4 text-ui-sm text-foreground-subtle">这是一个空文件。</p>
        ) : (
          <p role="status" className="p-4 text-ui-sm text-foreground-subtle">{!readsFile ? "该工具没有可显示的差异。" : result?.notice ?? "正在读取文件…"}</p>
        )}
      </div>
    </SidePanel>
  );
}
