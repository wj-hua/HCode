import type { FileInput } from "@hcode/shared/types";
import type { Conversation, QueuedMessage } from "../store/appStore";

// 重启后恢复未发送的草稿和排队消息，存 localStorage。图片是 base64，体积大，不持久化。
const DRAFT_PREFIX = "hcode:draft:";
const QUEUE_PREFIX = "hcode:queue:";

/** 草稿的存储 key：已有会话按会话 id，新建草稿按项目路径；对比组不持久化。 */
export function draftKey(conv: Pick<Conversation, "sessionId" | "projectPath" | "compareId">): string | null {
  if (conv.compareId) return null;
  return conv.sessionId ? `s:${conv.sessionId}` : `p:${conv.projectPath}`;
}

export function writePersisted(key: string, value: unknown | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储写不进去（配额等）时忽略，只是不能恢复
  }
}

export function readPersisted<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function loadDraft(key: string | null): { text: string; files: FileInput[] } {
  const saved = key ? readPersisted<{ text?: string; files?: FileInput[] }>(DRAFT_PREFIX + key) : null;
  return { text: saved?.text ?? "", files: saved?.files ?? [] };
}

export function saveDraft(key: string, text: string, files: readonly FileInput[]) {
  writePersisted(DRAFT_PREFIX + key, text || files.length ? { text, files } : null);
}

export function loadQueue(sessionId: string): QueuedMessage[] {
  const saved = readPersisted<QueuedMessage[]>(QUEUE_PREFIX + sessionId);
  return Array.isArray(saved) ? saved.map((item) => ({ ...item, images: [], files: item.files ?? [] })) : [];
}

export function saveQueue(sessionId: string, queue: readonly QueuedMessage[]) {
  const items = queue
    .map((item) => ({ ...item, images: [] }))
    .filter((item) => item.text.trim() || item.files.length > 0);
  writePersisted(QUEUE_PREFIX + sessionId, items.length ? items : null);
}

/** 会话被关闭或删除时丢弃它的草稿和队列。 */
export function discardPersisted(conv: Pick<Conversation, "sessionId" | "projectPath" | "compareId">) {
  const key = draftKey(conv);
  if (key) writePersisted(DRAFT_PREFIX + key, null);
  if (conv.sessionId) writePersisted(QUEUE_PREFIX + conv.sessionId, null);
}
