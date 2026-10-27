/** 桌面分栏；远程窄屏的预览覆盖会话，避免挤出面板操作。 */
import type { ReactNode } from "react";

export function FilePreviewLayout({ children, preview, mobileOverlay = false }: { children: ReactNode; preview?: ReactNode; mobileOverlay?: boolean }) {
  return <div className="file-preview-layout relative flex min-h-0 min-w-0 flex-1" data-mobile-overlay={mobileOverlay || undefined}>
    <div className="file-preview-conversation flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    {preview}
  </div>;
}
