import { ChevronRightIcon, CopyIcon, EllipsisIcon, ExternalLinkIcon, EyeIcon, FileCode2Icon, FolderOpenIcon, RefreshCwIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { MermaidBlock } from "@/components/ai-elements/mermaid-block.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { Button } from "@/components/ui/button.js";
import { CodeViewer } from "@/components/ui/code-viewer.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { HighlightedLightweightDiffPreview } from "@/components/ui/highlighted-lightweight-diff-preview.js";
import { toast } from "@/components/ui/toast.js";
import { FILE_VIEWER_MAX_TEXT_BYTES, buildUnifiedDiff, inferCodeLanguage, inferImageMediaType, type CodeViewerSource } from "@/lib/codeViewer.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { isMermaidLanguage } from "@/lib/mermaidLanguage.js";
import { getPathLeaf } from "@/lib/path.js";
import { getPlainTextPatchPreviewLines } from "@/lib/patchDiffPreview.js";
import { ImagePreviewContent, SvgPreviewContent } from "@/previewPaneImageContent.js";
import { resolveTheme } from "@/useTheme.js";
import { hcode } from "../bridge";
import { errorMessage } from "../store/appStore";
import { useUiStore } from "../store/uiStore";
import { useFilePreview } from "./FilePreviewContext";
import { SidePanel } from "./SidePanel";

type FileResult =
  | { kind: "text"; content: string }
  | { kind: "image"; url: string }
  | { kind: "notice"; notice: string };
type ViewMode = "preview" | "code";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const isSvgPath = (path?: string) => path?.toLowerCase().endsWith(".svg") ?? false;
const openExternal = (url: string) => void hcode.invoke("app:openExternal", url);
const copyText = (text: string) => {
  void hcode.invoke("app:copyText", text).then(() => toast("已复制"));
};

/** 工作区内的文件显示为「项目 › 目录 › 文件」，外部文件按绝对路径分段，与 ZCode 预览面板一致。 */
function buildBreadcrumb(path: string, workspacePath?: string) {
  const normalized = path.replace(/\\/g, "/");
  const root = workspacePath?.replace(/\\/g, "/").replace(/\/+$/, "");
  const inWorkspace = !!root && normalized.startsWith(`${root}/`);
  const segments = (inWorkspace ? normalized.slice(root.length + 1) : normalized).split("/").filter(Boolean);
  return {
    rootLabel: inWorkspace ? getPathLeaf(root) : "/",
    relativePath: inWorkspace ? segments.join("/") : path,
    parents: segments.slice(0, -1),
    fileLabel: segments.at(-1) ?? getPathLeaf(path),
  };
}

export function FilePreviewPanel({ source, onClose }: { source: CodeViewerSource; onClose: () => void }) {
  const preview = useFilePreview();
  const [result, setResult] = useState<FileResult | null>(null);
  const [revision, setRevision] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [markdownViewMode, setMarkdownViewMode] = useState<ViewMode>("preview");
  const [svgViewMode, setSvgViewMode] = useState<ViewMode>("preview");
  const [wrapOverride, setWrapOverride] = useState<boolean | null>(null);
  const settings = useUiStore((state) => state.codePreviewSettings);
  const theme = useUiStore((state) => state.theme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const previewTheme = (theme === "system" ? systemDark : resolveTheme(theme) === "dark") ? settings.darkTheme : settings.lightTheme;
  const wrapLongLines = wrapOverride ?? settings.wrapLongLines;
  const path = source.path;
  const workspacePath = source.workspacePath ?? preview?.workspacePath;
  const breadcrumb = useMemo(() => path ? buildBreadcrumb(path, workspacePath) : null, [path, workspacePath]);
  const patch = useMemo(() => source.type === "patch" ? source.patch
    : source.type === "multi-file-diff" ? buildUnifiedDiff(source.beforeContent, source.afterContent, source.title) : null, [source]);
  const inlineTooLarge = useMemo(() => {
    const text = source.type === "text" ? source.content : patch;
    return text ? new TextEncoder().encode(text).byteLength > FILE_VIEWER_MAX_TEXT_BYTES : false;
  }, [source, patch]);
  const lines = useMemo(() => patch ? getPlainTextPatchPreviewLines(patch) : [], [patch]);
  const readsFile = source.type !== "text" && source.type !== "patch" && source.type !== "multi-file-diff";
  // SVG 按文本读取，以便在预览和源码之间切换。
  const imageType = readsFile && !isSvgPath(path) ? inferImageMediaType(path) : null;

  useEffect(() => {
    setActionError(null);
    if (!readsFile || !path) return;
    let active = true;
    let imageUrl: string | null = null;
    setResult(null);
    const load = async (): Promise<FileResult> => {
      const info = await hcode.invoke("fs:stat", path);
      if (!info?.exists) return { kind: "notice", notice: "文件不存在或无法访问，可能已移动或删除。" };
      if (info.isDirectory) return { kind: "notice", notice: "这是一个文件夹，请在 Finder 中查看。" };
      if (imageType) {
        if (info.size > MAX_IMAGE_BYTES) return { kind: "notice", notice: "图片超过 10 MiB 预览上限，请用默认应用打开。" };
        const bytes = await hcode.invoke("fs:readMedia", path);
        if (!bytes) return { kind: "notice", notice: "无法读取该图片，请用默认应用打开。" };
        imageUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: imageType }));
        return { kind: "image", url: imageUrl };
      }
      if (info.size > FILE_VIEWER_MAX_TEXT_BYTES) return { kind: "notice", notice: "文件超过 256 KiB 预览上限，请用默认应用打开。" };
      const content = await hcode.invoke("fs:readText", path, FILE_VIEWER_MAX_TEXT_BYTES);
      return content === null
        ? { kind: "notice", notice: "该文件为二进制、非 UTF-8 文本或无法读取，请用默认应用打开。" }
        : { kind: "text", content };
    };
    void load().then(
      (value) => { if (active) setResult(value); },
      (error) => { if (active) setResult({ kind: "notice", notice: `读取文件失败：${errorMessage(error)}` }); },
    );
    return () => {
      active = false;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [source, path, readsFile, imageType, revision]);

  const perform = async (channel: "app:showInFinder" | "app:openPath") => {
    if (!path) return;
    setActionError(null);
    try {
      await hcode.invoke(channel, path);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };
  const content = source.type === "text" ? source.content : result?.kind === "text" ? result.content : undefined;
  const language = source.type === "text" ? source.language : inferCodeLanguage(path, content);
  const canToggleMarkdown = content !== undefined && language === "markdown";
  const canToggleSvg = content !== undefined && isSvgPath(path);
  const canToggleWrap = content !== undefined && !isMermaidLanguage(language)
    && !(canToggleMarkdown && markdownViewMode === "preview") && !(canToggleSvg && svgViewMode === "preview");
  const hasViewOptions = canToggleMarkdown || canToggleSvg || canToggleWrap;

  const renderBody = () => {
    if (inlineTooLarge) {
      return <p role="status" className="p-4 text-ui-sm text-foreground-subtle">工具内容超过 256 KiB 预览上限。{path ? "请用默认应用打开文件。" : "请在工具卡片中查看。"}</p>;
    }
    if (patch) {
      return <HighlightedLightweightDiffPreview codePreviewSettings={settings} language={inferCodeLanguage(path)} lines={lines} path={path} theme={previewTheme} />;
    }
    if (result?.kind === "image") {
      return <ImagePreviewContent title={source.title} imageSource={result.url} sourcePath={path} />;
    }
    if (content === undefined) {
      const notice = !readsFile ? "该工具没有可显示的差异。" : result?.kind === "notice" ? result.notice : imageType ? "正在读取图片…" : "正在读取文件…";
      return <p role="status" className="p-4 text-ui-sm text-foreground-subtle">{notice}</p>;
    }
    if (!content.length) return <p role="status" className="p-4 text-ui-sm text-foreground-subtle">这是一个空文件。</p>;
    if (canToggleMarkdown && markdownViewMode === "preview") {
      return (
        <div className="p-4">
          <MessageResponse
            className="min-w-0 break-words"
            theme={theme}
            codePreviewSettings={settings}
            workspacePath={workspacePath}
            onOpenFileLink={preview?.onOpenFileLink}
            onOpenCodeViewer={preview?.onOpenCodeViewer}
            onOpenExternalUrl={openExternal}
          >
            {content}
          </MessageResponse>
        </div>
      );
    }
    if (canToggleSvg && svgViewMode === "preview") return <SvgPreviewContent title={source.title} svgContent={content} />;
    if (isMermaidLanguage(language)) {
      return <div className="p-4"><MermaidBlock code={content} theme={theme} className="rounded-xl border border-border" /></div>;
    }
    return <CodeViewer code={content} language={language} theme={previewTheme} showLineNumbers={settings.showLineNumbers} wrapLongLines={wrapLongLines} fontSizePx={settings.fontSizePx} />;
  };

  const title = breadcrumb ? (
    <span className="flex min-w-0 items-center gap-0.5 text-ui-base font-normal text-foreground-subtle" title={path}>
      <span className="min-w-0 truncate">{breadcrumb.rootLabel}</span>
      {breadcrumb.parents.map((segment, index) => (
        <Fragment key={`${segment}-${index}`}>
          <ChevronRightIcon className="size-3.5 shrink-0 text-foreground-subtlest" />
          <span className="min-w-0 truncate">{segment}</span>
        </Fragment>
      ))}
      <ChevronRightIcon className="size-3.5 shrink-0 text-foreground-subtlest" />
      {/* 空间不足时先压缩目录段，尽量保留文件名完整。 */}
      <span className="inline-flex min-w-0 max-w-full shrink-0 items-center gap-1 font-medium text-foreground">
        <FileDisplayIcon src={resolveFileDisplayDescriptor(path!).fileIconSrc} size={14} className="shrink-0" />
        <span className="truncate">{breadcrumb.fileLabel}</span>
      </span>
    </span>
  ) : source.title;

  const actions = (
    <>
      {!readsFile && path ? (
        <Button variant="ghost" size="sm" className="gap-1 text-foreground-subtle hover:text-foreground" onClick={() => preview?.onOpenFileLink({ path, label: getPathLeaf(path) })}>
          <FileCode2Icon className="size-3.5" />查看文件
        </Button>
      ) : null}
      {readsFile && path ? (
        <Button variant="ghost" size="icon-sm" title="刷新" aria-label="刷新文件预览" onClick={() => setRevision((value) => value + 1)}><RefreshCwIcon /></Button>
      ) : null}
      {hasViewOptions || path ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="更多" aria-label="更多"><EllipsisIcon /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {canToggleMarkdown ? (
              <>
                <DropdownMenuLabel>Markdown</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={markdownViewMode} onValueChange={(value) => setMarkdownViewMode(value as ViewMode)}>
                  <DropdownMenuRadioItem value="preview"><EyeIcon className="size-4" />预览</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="code"><FileCode2Icon className="size-4" />源码</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </>
            ) : null}
            {canToggleSvg ? (
              <>
                <DropdownMenuLabel>SVG</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={svgViewMode} onValueChange={(value) => setSvgViewMode(value as ViewMode)}>
                  <DropdownMenuRadioItem value="preview"><EyeIcon className="size-4" />预览</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="code"><FileCode2Icon className="size-4" />源码</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </>
            ) : null}
            {canToggleWrap ? (
              <>
                {canToggleMarkdown || canToggleSvg ? <DropdownMenuSeparator /> : null}
                <DropdownMenuCheckboxItem checked={wrapLongLines} onCheckedChange={(checked) => setWrapOverride(Boolean(checked))}>
                  <FileCode2Icon className="size-4" />自动换行
                </DropdownMenuCheckboxItem>
              </>
            ) : null}
            {path && breadcrumb ? (
              <>
                {hasViewOptions ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onSelect={() => copyText(path)}><CopyIcon className="size-4" />复制绝对路径</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => copyText(breadcrumb.relativePath)}><CopyIcon className="size-4" />复制相对路径</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void perform("app:showInFinder")}><FolderOpenIcon className="size-4" />在 Finder 中显示</DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {path ? (
        <Button variant="ghost" size="icon-sm" title="用默认应用打开" aria-label="用默认应用打开" onClick={() => void perform("app:openPath")}><ExternalLinkIcon /></Button>
      ) : null}
    </>
  );

  return (
    <SidePanel label="文件预览面板" title={title} onClose={onClose} actions={actions}>
      {actionError ? <p role="alert" className="shrink-0 break-words border-b border-border px-4 py-2 text-ui-sm text-destructive">打开失败：{actionError}</p> : null}
      <div className="min-h-0 flex-1 overflow-auto">{renderBody()}</div>
    </SidePanel>
  );
}
