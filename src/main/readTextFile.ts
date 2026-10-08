import { open, stat } from "node:fs/promises";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** 只读取有界的 UTF-8 文本；空文件返回空串，无法预览时返回 null。 */
export async function readTextFile(path: string, maxBytes = MAX_TEXT_BYTES): Promise<string | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
  const limit = Math.min(maxBytes, MAX_TEXT_BYTES);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > limit) return null;
    const file = await open(path, "r");
    try {
      const current = await file.stat();
      if (!current.isFile() || current.size > limit) return null;
      const chunks: Buffer[] = [];
      // 多读一个字节，以识别 stat 后增长的文件，同时严格限制读取量。
      for await (const chunk of file.createReadStream({ start: 0, end: limit, autoClose: false })) {
        chunks.push(chunk as Buffer);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length > limit) return null;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return /[\u0000-\u0008\u000b\u000e-\u001a\u001c-\u001f]/.test(text) ? null : text;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}
