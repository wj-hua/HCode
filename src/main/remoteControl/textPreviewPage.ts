// 每次只读一段 UTF-8 文本；游标绑定文件版本，避免翻页时拼入已修改的内容。
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { RemoteTextPage } from "../../shared/remoteControl.js";

const PAGE_BYTES = 64 * 1024;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION = 0x80;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000e-\u001a\u001c-\u001f]/;

export async function readTextPage(path: string, offset: unknown, version: unknown): Promise<RemoteTextPage> {
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("无效的文本位置");
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (!info.isFile() || offset > info.size || (offset > 0 && version !== stamp)) throw new Error("文件已变化，请刷新预览");
    const buffer = Buffer.alloc(Math.min(PAGE_BYTES + 1, info.size - offset));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
      if (!read.bytesRead) throw new Error("文件已变化，请刷新预览");
      bytesRead += read.bytesRead;
    }
    let end = Math.min(bytesRead, PAGE_BYTES);
    if (bytesRead > PAGE_BYTES) {
      while (end > 0 && (buffer[end]! & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION) end--;
    }
    if (end === 0 && offset < info.size) throw new Error("无法读取文本，请刷新文件");
    const bytes = buffer.subarray(0, end);
    if (!isUtf8(bytes)) throw new Error("不是有效的 UTF-8 文本，无法预览");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: offset !== 0 }).decode(bytes);
    if (CONTROL_CHARACTERS.test(text)) throw new Error("二进制文件不支持文本预览");
    return { text, next: offset + end < info.size ? offset + end : null, version: stamp };
  } finally { await file.close(); }
}
