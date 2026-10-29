// 图片附件缩略图：输入框里待发送的图片、用户气泡里已发送的图片共用。点击放大复用 ZCode 的图片预览。
import { XIcon } from "lucide-react";
import { useState } from "react";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import { cn } from "@/components/lib/utils.js";
import { REMOTE_MEDIA_PATH } from "@hcode/shared/remoteControl";

export interface ImageThumb {
  src: string;
  name: string;
}

export function ImageAttachments({
  images,
  onRemove,
  className,
}: {
  images: readonly ImageThumb[];
  onRemove?: (index: number) => void;
  className?: string;
}) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  if (images.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {images.map((image, index) => (
        <div key={`${index}-${image.name}`} className="group relative">
          <button
            type="button"
            onClick={() => setPreviewIndex(index)}
            className="block size-16 cursor-zoom-in overflow-hidden rounded-lg border border-border bg-background"
          >
            <img src={image.src.startsWith(REMOTE_MEDIA_PATH) ? `${image.src}?thumbnail=1` : image.src} alt={image.name} loading="lazy" decoding="async" className="size-full object-cover" />
          </button>
          {onRemove ? (
            // 触屏没有悬停，移除按钮常显（照 ZCode 附件的 [@media(hover:none)]）；外层留出更大的点击区域。
            <button
              type="button"
              title="移除"
              aria-label={`移除 ${image.name}`}
              onClick={() => onRemove(index)}
              className="absolute -top-2.5 -right-2.5 hidden size-7 items-center justify-center group-hover:flex focus-visible:flex [@media(hover:none)]:flex"
            >
              <span className="flex size-5 items-center justify-center rounded-full bg-foreground text-background">
                <XIcon className="size-3" />
              </span>
            </button>
          ) : null}
        </div>
      ))}
      <ImagePreviewDialog
        open={previewIndex !== null}
        initialIndex={previewIndex ?? 0}
        items={images.map((image) => ({ src: image.src, alt: image.name, filename: image.name }))}
        onOpenChange={(open) => {
          if (!open) setPreviewIndex(null);
        }}
      />
    </div>
  );
}
