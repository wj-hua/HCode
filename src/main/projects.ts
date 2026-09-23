// 项目列表 = 所有会话的 cwd ∪ 用户手动添加的目录 − 用户移除的目录。
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Project, SessionSummary } from "../shared/types.js";
import type { AppStore } from "./appStore.js";

export function buildProjects(sessions: readonly SessionSummary[], store: AppStore): Project[] {
  const { pinned, manual, removed } = store.projects;
  const removedSet = new Set(removed);
  const byPath = new Map<string, Project>();

  const ensure = (path: string, isManual: boolean): Project => {
    let project = byPath.get(path);
    if (!project) {
      project = {
        path,
        name: basename(path) || path,
        lastActiveAt: 0,
        sessionCount: 0,
        pinned: pinned.includes(path),
        manual: isManual,
        exists: existsSync(path),
      };
      byPath.set(path, project);
    }
    return project;
  };

  for (const session of sessions) {
    if (removedSet.has(session.projectPath)) continue;
    const project = ensure(session.projectPath, false);
    project.sessionCount += 1;
    project.lastActiveAt = Math.max(project.lastActiveAt, session.updatedAt);
  }
  for (const path of manual) {
    if (!removedSet.has(path)) ensure(path, true);
  }

  return [...byPath.values()].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastActiveAt - a.lastActiveAt;
  });
}
