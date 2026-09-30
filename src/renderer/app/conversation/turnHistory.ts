import type { EventMap } from "@hcode/shared/ipc";
import type { GitTurnDiff, GitTurnRecord } from "@hcode/shared/types";
import { readPersisted, writePersisted } from "../composer/persist";
import type { Conversation } from "../store/appStore";

const PREFIX = "hcode:turn-history:";
export const MAX_TURN_RECORDS = 20;
type SessionIdentity = Pick<Conversation, "agent" | "projectPath" | "sessionId">;

function key(session: SessionIdentity): string | null {
  return session.sessionId ? PREFIX + JSON.stringify([session.agent, session.projectPath, session.sessionId]) : null;
}

/** 只接受摘要字段，同时清掉意外写入的 patch、正文和旧运行时标记。 */
function summary(value: unknown): GitTurnRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as GitTurnRecord;
  if (typeof record.id !== "string" || !record.id || typeof record.root !== "string" || !record.root
    || (record.head !== null && (typeof record.head !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.head)))
    || !Number.isFinite(record.recordedAt) || record.recordedAt <= 0 || typeof record.prompt !== "string" || !Array.isArray(record.files)) return null;
  const hash = (value: unknown) => value === undefined || value === null || typeof value === "string";
  if (record.files.some((file) => !file || typeof file.path !== "string" || !file.path
    || !["added", "modified", "deleted"].includes(file.status)
    || !Number.isSafeInteger(file.additions) || file.additions < 0 || !Number.isSafeInteger(file.deletions) || file.deletions < 0
    || !hash(file.beforeHash) || !hash(file.afterHash))) return null;
  return {
    id: record.id, root: record.root, head: record.head, recordedAt: record.recordedAt, prompt: record.prompt.slice(0, 200),
    files: record.files.map((file) => ({
      path: file.path, status: file.status, additions: file.additions, deletions: file.deletions,
      beforeHash: file.beforeHash, afterHash: file.afterHash,
      ...(file.previewUnavailable === true ? { previewUnavailable: true } : {}),
    })),
  };
}

function bounded(records: GitTurnRecord[]): GitTurnRecord[] {
  // 队列会让较早一轮的 diff 晚到；按发送时间排序，而不是按事件到达顺序。
  const unique = new Map(records.map((record) => [record.id, record]));
  return [...unique.values()].sort((a, b) => a.recordedAt - b.recordedAt).slice(-MAX_TURN_RECORDS);
}

export function loadTurnHistory(session: SessionIdentity): GitTurnRecord[] {
  const storageKey = key(session);
  const saved = storageKey ? readPersisted<unknown>(storageKey) : null;
  if (!Array.isArray(saved)) return [];
  return bounded(saved.map(summary).filter((record): record is GitTurnRecord => record !== null));
}

export function saveTurnHistory(session: SessionIdentity, records: readonly GitTurnRecord[]): void {
  const storageKey = key(session);
  if (!storageKey) return;
  const clean = bounded(records.map(summary).filter((record): record is GitTurnRecord => record !== null));
  writePersisted(storageKey, clean.length ? clean : null);
}

export function discardTurnHistory(session: SessionIdentity): void {
  const storageKey = key(session);
  if (storageKey) writePersisted(storageKey, null);
}

export function recordFromDiff(diff: GitTurnDiff): GitTurnRecord | null {
  return diff.error ? null : summary({ ...diff, prompt: diff.prompt ?? "" });
}

/** 迟到的上一轮只进入历史，不能覆盖当前轮的面板或可写快照。 */
export function turnDiffPatch(
  conversation: Pick<Conversation, "currentTurnId" | "turnHistory">,
  { diff, turnId }: Pick<EventMap["git:turnDiff"], "diff" | "turnId">,
): Partial<Conversation> {
  if (diff === null) return { turnDiff: null, currentTurnId: turnId };
  const record = recordFromDiff(diff);
  // 记录轮次结束时的清单；后续提交、撤销或刷新只更新当前面板，不改写历史统计。
  const patch: Partial<Conversation> = record && !conversation.turnHistory.some((item) => item.id === record.id)
    ? { turnHistory: bounded([...conversation.turnHistory, record]) }
    : {};
  if (!conversation.currentTurnId || (diff.id ?? turnId) === conversation.currentTurnId) {
    patch.turnDiff = diff;
  }
  return patch;
}
