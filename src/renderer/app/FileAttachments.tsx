import { AlertCircleIcon, FileIcon, FileVideoIcon, LoaderIcon, PackageIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { hcode } from "./bridge";

export interface FileAttachmentItem {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

/** 输入框里尚未暂存完成的附件；progress 为 null 表示拿不到进度（本机 IPC）。 */
export interface FileUploadItem {
  id: string;
  name: string;
  mimeType: string;
  progress: number | null;
  error?: string;
}

function fileIcon(name: string, mimeType: string) {
  return mimeType.startsWith("video/") ? FileVideoIcon : name.toLowerCase().endsWith(".apk") ? PackageIcon : FileIcon;
}

// 负外边距加内边距：放大手机上的点击区域，不撑大附件条。
const ICON_BUTTON = "-m-1 shrink-0 rounded-md p-1 text-foreground-subtle hover:bg-hover hover:text-foreground";

export function FileAttachments({ files, uploads = [], onRemove, onCancelUpload, onRetryUpload, onPreview, className }: {
  files: readonly FileAttachmentItem[];
  uploads?: readonly FileUploadItem[];
  onRemove?: (index: number) => void;
  onCancelUpload?: (id: string) => void;
  onRetryUpload?: (id: string) => void;
  onPreview?: (path: string) => void;
  className?: string;
}) {
  if (files.length === 0 && uploads.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {files.map((file, index) => {
        const Icon = fileIcon(file.name, file.mimeType);
        return (
          <div key={`${file.path}-${index}`} className="flex max-w-60 items-center gap-2 rounded-lg border border-border bg-background px-2 py-1.5 text-ui-sm">
            <Icon className="size-4 shrink-0 text-foreground-subtle" />
            <button type="button" title={file.path} className="min-w-0 truncate text-left hover:underline" onClick={() => onPreview ? onPreview(file.path) : void hcode.invoke("app:showInFinder", file.path)}>
              {file.name}
            </button>
            {onRemove ? (
              <button type="button" aria-label={`移除 ${file.name}`} title="移除" onClick={() => onRemove(index)} className={ICON_BUTTON}>
                <XIcon className="size-3.5" />
              </button>
            ) : null}
          </div>
        );
      })}
      {uploads.map((upload) => {
        const Icon = upload.error ? AlertCircleIcon : fileIcon(upload.name, upload.mimeType);
        const status = upload.error ? "上传失败" : upload.progress === null ? "上传中" : `${upload.progress}%`;
        return (
          <div
            key={upload.id}
            role={upload.error ? "alert" : "status"}
            title={upload.error ? `${upload.name}：${upload.error}` : `正在上传 ${upload.name}`}
            className={cn("relative flex max-w-60 items-center gap-2 overflow-hidden rounded-lg border bg-background px-2 py-1.5 text-ui-sm", upload.error ? "border-destructive/40" : "border-border")}
          >
            {upload.error ? <Icon className="size-4 shrink-0 text-destructive" /> : <LoaderIcon className="size-4 shrink-0 animate-spin text-foreground-subtle" />}
            <span className="min-w-0 truncate text-foreground-subtle">{upload.name}</span>
            <span className={cn("shrink-0 tabular-nums", upload.error ? "text-destructive" : "text-foreground-subtle")}>{status}</span>
            {upload.error && onRetryUpload ? (
              <button type="button" aria-label={`重试上传 ${upload.name}`} title="重试上传" onClick={() => onRetryUpload(upload.id)} className={cn(ICON_BUTTON, "text-destructive")}>
                <RotateCcwIcon className="size-3.5" />
              </button>
            ) : null}
            {onCancelUpload ? (
              <button type="button" aria-label={`${upload.error ? "移除" : "取消上传"} ${upload.name}`} title={upload.error ? "移除" : "取消上传"} onClick={() => onCancelUpload(upload.id)} className={ICON_BUTTON}>
                <XIcon className="size-3.5" />
              </button>
            ) : null}
            {!upload.error && upload.progress !== null ? (
              <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-brand transition-[width] duration-200" style={{ width: `${upload.progress}%` }} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
