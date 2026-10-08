import type { SessionSummary } from "./types.js";

export function sessionPinKey(session: Pick<SessionSummary, "agent" | "id">): string {
  return `${session.agent}:${session.id}`;
}

/** 仅供项目内会话列表使用：置顶优先，同组按最近活动时间排序。 */
export function sortSessionsWithPins(
  sessions: readonly SessionSummary[],
  pinnedSessions: readonly string[],
): SessionSummary[] {
  const pinned = new Set(pinnedSessions);
  return [...sessions].sort((a, b) =>
    Number(pinned.has(sessionPinKey(b))) - Number(pinned.has(sessionPinKey(a))) || b.updatedAt - a.updatedAt,
  );
}
