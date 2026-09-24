import { FileIcon, FileVideoIcon, PackageIcon, XIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { hcode } from "./bridge";

export interface FileAttachmentItem {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

export function FileAttachments({ files, onRemove, className }: {
  files: readonly FileAttachmentItem[];
  onRemove?: (index: number) => void;
  className?: string;
}) {
  if (files.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {files.map((file, index) => {
        const Icon = file.mimeType.startsWith("video/") ? FileVideoIcon : file.name.toLowerCase().endsWith(".apk") ? PackageIcon : FileIcon;
        return (
          <div key={`${file.path}-${index}`} className="flex max-w-60 items-center gap-2 rounded-lg border border-border bg-background px-2 py-1.5 text-ui-sm">
            <Icon className="size-4 shrink-0 text-foreground-subtle" />
            <button type="button" title={file.path} className="min-w-0 truncate text-left hover:underline" onClick={() => void hcode.invoke("app:showInFinder", file.path)}>
              {file.name}
            </button>
            {onRemove ? (
              <button type="button" aria-label={`移除 ${file.name}`} onClick={() => onRemove(index)} className="shrink-0 text-foreground-subtle hover:text-foreground">
                <XIcon className="size-3.5" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
