/** 文件预览与整个会话（含对比视图及输入框）共占一行，预览始终参与布局。 */
import type { ReactNode } from "react";

export function FilePreviewLayout({ children, preview }: { children: ReactNode; preview?: ReactNode }) {
  return <div className="file-preview-layout flex min-h-0 min-w-0 flex-1">
    <div className="file-preview-conversation flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    {preview}
  </div>;
}
