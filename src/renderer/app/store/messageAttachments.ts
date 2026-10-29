// 编辑/重发时才恢复原始图片输入；普通阅读只需要远程缩略图，文件路径保持原契约。
import type { ConversationRow, FileInput, ImageInput } from "@hcode/shared/types";
import { REMOTE_MEDIA_PATH } from "@hcode/shared/remoteControl";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const BASE64_CHUNK_BYTES = 32 * 1024;
const IMAGE_TIMEOUT_MS = 30_000;
type UserRow = Extract<ConversationRow, { kind: "userInput" }>;

export async function restoreMessageAttachments(row: UserRow): Promise<{ images: ImageInput[]; files: FileInput[] }> {
  const images: ImageInput[] = [];
  const files: FileInput[] = [];
  for (const item of row.attachments ?? []) {
    const inline = /^data:([^;,]+);base64,([\s\S]*)$/.exec(item.ref);
    if (inline) images.push({ mimeType: inline[1]!, data: inline[2]!, name: item.fileName });
    else if (item.ref.startsWith(REMOTE_MEDIA_PATH)) images.push(await readOriginalImage(item.ref, item.fileName));
    else if (item.ref.startsWith("/")) files.push({ path: item.ref, name: item.fileName, mimeType: item.mime, size: item.bytes });
  }
  return { images, files };
}

async function readOriginalImage(ref: string, name: string): Promise<ImageInput> {
  const response = await fetch(ref, { credentials: "same-origin", signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`读取原图失败（${response.status}），请重新加载会话`);
  const length = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_IMAGE_BYTES) throw new Error("原图大小无效或超过 20 MiB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("原图超过 20 MiB");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  return { mimeType: response.headers.get("content-type")!, data: btoa(binary), name };
}
