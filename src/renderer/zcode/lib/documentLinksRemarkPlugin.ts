// 在 Markdown 渲染器规范化 href 之前解析文档链接，保留父目录与文档目录的关系。
import type { Plugin } from "unified";
import { getContainingDirectoryPath, isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
import { normalizeWorkspaceRelativeFilePath } from "@/lib/markdownFileLink.js";

interface LinkNode { type: string; url?: string; children?: LinkNode[] }

export function documentLinksRemarkPlugin(documentPath: string, workspace: string): Plugin {
  const directory = getContainingDirectoryPath(documentPath);
  const root = workspace.replace(/\\/g, "/").replace(/\/$/, "");
  const parent = directory?.replace(/\\/g, "/");
  // 文档在项目外时，以该文档的目录作为能够回退的边界。
  const inWorkspace = parent === root || parent?.startsWith(root + "/");
  const base = inWorkspace ? root : parent;
  const prefix = inWorkspace ? parent!.slice(root.length + 1) : "";
  const visit = (node: LinkNode) => {
    const url = node.url;
    if (base && url && ["link", "image", "definition"].includes(node.type)
        && !isAbsoluteFilePath(url) && !/^(?:[a-z][a-z0-9+.-]*:|[?#~])/i.test(url)) {
      const suffixAt = url.search(/[?#]/);
      const path = suffixAt < 0 ? url : url.slice(0, suffixAt);
      // 在检查 .. 之前解码点号，不能把编码的路径穿越留给后续解析器。
      const relative = normalizeWorkspaceRelativeFilePath([prefix, path.replace(/%2e/ig, ".")].join("/"));
      node.url = relative === null ? "" : joinFilePath(base, relative) + (suffixAt < 0 ? "" : url.slice(suffixAt));
    }
    node.children?.forEach(visit);
  };
  return () => tree => { visit(tree as LinkNode); };
}
