/** 隔离 SDK 全局索引的元信息限制；目录只由 SDK 的项目查询确认，不猜测编码后的目录名。 */
import { listSessions, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";

/**
 * SDK 的全局扫描只读首尾各 64 KiB。首条消息过大时 cwd 可能缺失，指定 dir 的查询
 * 可以从项目查询上下文补全它；只修补缺失字段，保留原会话身份与已知目录。
 */
export async function listClaudeSessionInfos(projectPaths: readonly string[]): Promise<SDKSessionInfo[]> {
  const sessions = await listSessions();
  const missingDirectories = new Map(sessions.filter(session => !session.cwd).map(session => [session.sessionId, session]));
  if (!missingDirectories.size || !projectPaths.length) return sessions;

  const projectLists = await Promise.all(projectPaths.map(dir => listSessions({ dir, includeWorktrees: false })));
  const recovered = new Map<string, SDKSessionInfo>();
  for (const session of projectLists.flat()) {
    const original = missingDirectories.get(session.sessionId);
    if (original && session.cwd) recovered.set(session.sessionId, { ...original, cwd: session.cwd });
  }
  console.info("[ClaudeHistory] 已通过项目查询核对全局索引缺失的目录", {
    missing: missingDirectories.size,
    recovered: recovered.size,
    projects: projectPaths.length,
  });
  return sessions.map(session => recovered.get(session.sessionId) ?? session);
}
