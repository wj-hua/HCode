/** 消息正文的本地文件路径转为 Markdown 链接；不读取文件，路径准入复用现有预览规则。 */
import type { Plugin } from "unified";
import { parseMarkdownFileLinkTarget, resolveMarkdownFileLink } from "@/lib/markdownFileLink.js";

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

const SKIPPED_NODES = new Set([
  "code", "html", "link", "linkReference", "image", "imageReference", "definition", "math", "inlineMath",
]);
const PATH_TOKEN_RE = /[^\s<>"'`，。！？；：、（）【】《》「」]+/gu;
const LEADING_PUNCTUATION_RE = /^[([{]+/u;
const TRAILING_PUNCTUATION_RE = /[)\]},.;!?]+$/u;
const FILE_EXTENSION_RE = /\.([a-z][a-z\d]*)$/iu;
const WINDOWS_DRIVE_RE = /^[a-z]:[\\/]/iu;
const URI_SCHEME_RE = /^[a-z][a-z\d+.-]*:/iu;
const INVALID_PATH_CHARACTERS_RE = /[<>"'`|?*;=&\r\n]/u;
// 无目录的名称需要常见文件扩展名，避免把域名、版本号当成项目文件。
const BARE_FILE_EXTENSIONS = new Set([
  "md", "mdx", "txt", "html", "htm", "css", "scss", "less", "js", "jsx", "mjs", "cjs", "ts", "tsx",
  "json", "jsonc", "yaml", "yml", "toml", "xml", "svg", "csv", "sql", "sh", "py", "rb", "go", "rs",
  "c", "h", "cpp", "hpp", "java", "kt", "swift", "ets", "vue", "svelte", "pdf", "docx", "xlsx", "pptx",
]);

/** 只接受完整路径；行内代码里的命令或表达式不能提取出局部路径。 */
function resolvePathHref(candidate: string, workspacePath: string, homePath?: string): string | null {
  if (INVALID_PATH_CHARACTERS_RE.test(candidate) || candidate.includes("://") || candidate.startsWith("//")) return null;
  const { path } = parseMarkdownFileLinkTarget(candidate);
  if (URI_SCHEME_RE.test(path) && !WINDOWS_DRIVE_RE.test(path)) return null;
  const extension = path.match(FILE_EXTENSION_RE)?.[1]?.toLowerCase();
  if (!extension) return null;

  const hasDirectory = /[\\/]/u.test(path);
  if (!hasDirectory && (!BARE_FILE_EXTENSIONS.has(extension) || /[@\s]/u.test(path) || path.startsWith("www."))) return null;
  // 空格只允许出现在目录之后，`pnpm run docs/guide.md` 因而仍是命令文本。
  const firstSegment = path.split(/[\\/]/u)[0];
  if (firstSegment && /\s/u.test(firstSegment)) return null;
  const href = hasDirectory ? candidate : `./${candidate}`;
  return resolveMarkdownFileLink(workspacePath, href, { homePath }) ? href : null;
}

function fileLink(href: string, child: MarkdownNode): MarkdownNode {
  return { type: "link", url: href, children: [child] };
}

function linkTextPaths(value: string, workspacePath: string, homePath?: string): MarkdownNode[] | null {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(PATH_TOKEN_RE)) {
    const token = match[0];
    const candidate = token.replace(LEADING_PUNCTUATION_RE, "").replace(TRAILING_PUNCTUATION_RE, "");
    const href = resolvePathHref(candidate, workspacePath, homePath);
    if (!href) continue;
    const start = match.index + token.indexOf(candidate);
    if (start > cursor) nodes.push({ type: "text", value: value.slice(cursor, start) });
    nodes.push(fileLink(href, { type: "text", value: candidate }));
    cursor = start + candidate.length;
  }
  if (!nodes.length) return null;
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

function transformPaths(node: MarkdownNode, workspacePath: string, homePath?: string): void {
  if (!node.children || SKIPPED_NODES.has(node.type)) return;
  node.children = node.children.flatMap(child => {
    if (child.type === "text" && child.value) return linkTextPaths(child.value, workspacePath, homePath) ?? [child];
    if (child.type === "inlineCode" && child.value) {
      const href = resolvePathHref(child.value, workspacePath, homePath);
      return href ? [fileLink(href, child)] : [child];
    }
    transformPaths(child, workspacePath, homePath);
    return [child];
  });
}

/** 在已有链接/citation 之后转换，生成的链接交给现有文件按钮与右侧预览处理。 */
export function createPlainFilePathRemarkPlugin(workspacePath: string, homePath?: string): Plugin {
  return function plainFilePathRemarkPlugin() {
    return (tree: unknown) => transformPaths(tree as MarkdownNode, workspacePath, homePath);
  };
}
