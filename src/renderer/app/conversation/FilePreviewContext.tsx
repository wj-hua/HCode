import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { resolveMarkdownFileLink } from "@/lib/markdownFileLink.js";
import { getPathLeaf, joinFilePath } from "@/lib/path.js";
import { useAppStore } from "../store/appStore";
import { useUiStore } from "../store/uiStore";

interface FilePreviewActions {
  workspacePath: string;
  onOpenCodeViewer(source: CodeViewerSource): void;
  onOpenFileLink(target: MessageFileLinkTarget, rowId?: number): void;
  onOpenFilePath(path: string): void;
}

const FilePreviewContext = createContext<FilePreviewActions | undefined>(undefined);

/** 预览归属实际点击的会话，对比分栏的键盘点击也不会借用另一列的目录。 */
export function FilePreviewProvider({ viewId, workspacePath, children }: {
  viewId: string;
  workspacePath: string;
  children: ReactNode;
}) {
  const setSidePanel = useUiStore((state) => state.setSidePanel);
  const actions = useMemo<FilePreviewActions>(() => {
    const onOpenCodeViewer = (source: CodeViewerSource) => {
      setSidePanel({
        type: "file",
        viewId,
        source: { ...source, ...(source.path ? { path: joinFilePath(workspacePath, source.path) } : {}), workspacePath },
      });
    };
    const onOpenFileLink = (target: MessageFileLinkTarget, rowId?: number) => {
      const conv = useAppStore.getState().conversations[viewId];
      const source = conv?.sessionKey ? { sessionKey: conv.sessionKey, projectPath: workspacePath }
        : conv?.sessionId ? { ref: { agent: conv.agent, projectPath: workspacePath, id: conv.sessionId } } : undefined;
      const htmlProof = source && rowId !== undefined ? { source, rowId } : undefined;
      onOpenCodeViewer({ type: "file", title: getPathLeaf(target.path), path: target.path, htmlSuffix: target.htmlSuffix, htmlProof });
    };
    return {
      workspacePath,
      onOpenCodeViewer,
      onOpenFileLink,
      onOpenFilePath(path) {
        // 用户 mention 可能只包含文件名；解析器需要显式的 ./ 来识别相对路径。
        const target = resolveMarkdownFileLink(workspacePath, path)
          ?? (/^[^/\\:?#]+$/.test(path) ? resolveMarkdownFileLink(workspacePath, `./${path}`) : null);
        if (target) onOpenFileLink({ path: target.path, label: getPathLeaf(target.path) });
      },
    };
  }, [viewId, workspacePath, setSidePanel]);
  return <FilePreviewContext.Provider value={actions}>{children}</FilePreviewContext.Provider>;
}

export const useFilePreview = () => useContext(FilePreviewContext);
