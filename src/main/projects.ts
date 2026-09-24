// 项目列表 = 用户手动添加的目录；会话只用来统计各项目的会话数和最近活跃时间。
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Project, SessionSummary } from "../shared/types.js";
import type { AppStore } from "./appStore.js";

export function buildProjects(sessions: readonly SessionSummary[], store: AppStore): Project[] {
  const { pinned, manual } = store.projects;
  const byPath = new Map<string, Project>(
    manual.map((path) => [
      path,
      {
        path,
        name: basename(path) || path,
        lastActiveAt: 0,
        sessionCount: 0,
        pinned: pinned.includes(path),
        exists: existsSync(path),
      },
    ]),
  );

  for (const session of sessions) {
    const project = byPath.get(session.projectPath);
    if (!project) continue;
    project.sessionCount += 1;
    project.lastActiveAt = Math.max(project.lastActiveAt, session.updatedAt);
  }

  return [...byPath.values()].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastActiveAt - a.lastActiveAt;
  });
}
