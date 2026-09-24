import type { FileInput } from "../../shared/types.js";

const FILES_HEADER = "附件文件（本机绝对路径，请按需读取或分析）：\n";

/** 文件路径属于单次用户输入；让 CLI 的文件工具读取原文件。 */
export function withFileReferences(text: string, files: readonly FileInput[]): string {
  if (files.length === 0) return text;
  const references = files.map((file) => `- ${JSON.stringify(file)}`).join("\n");
  // 只有空白的文字不保留，否则历史里无法按清单格式还原附件
  return `${text.trim() ? `${text}\n\n` : ""}${FILES_HEADER}${references}`;
}

/** CLI 历史只保存 prompt；从尾部的附件清单还原用户气泡。 */
export function extractFileReferences(text: string): { text: string; files: FileInput[] } {
  const start = text.lastIndexOf(FILES_HEADER);
  if (start < 0) return { text, files: [] };
  const prefix = text.slice(0, start);
  if (prefix && !prefix.endsWith("\n\n")) return { text, files: [] };
  const lines = text.slice(start + FILES_HEADER.length).trimEnd().split("\n");
  if (lines.length === 0) return { text, files: [] };
  const files: FileInput[] = [];
  try {
    for (const line of lines) {
      if (!line.startsWith("- ")) return { text, files: [] };
      const value: unknown = JSON.parse(line.slice(2));
      if (!value || typeof value !== "object") return { text, files: [] };
      const file = value as Record<string, unknown>;
      if (typeof file.path !== "string" || typeof file.name !== "string" || typeof file.mimeType !== "string" || typeof file.size !== "number") return { text, files: [] };
      files.push({ path: file.path, name: file.name, mimeType: file.mimeType, size: file.size });
    }
  } catch {
    return { text, files: [] };
  }
  return { text: prefix.trimEnd(), files };
}
