// 工作区索引：用户项目与应用管理的对话目录分别归类，会话提供活动时间和数量。
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Project, SessionSummary } from "../shared/types.js";
import type { AppStore } from "./appStore.js";

export function buildProjects(sessions: readonly SessionSummary[], store: AppStore, conversationPath: string): Project[] {
  const { pinned, manual } = store.projects;
  const byPath = new Map<string, Project>(
    manual.filter((path) => path !== conversationPath).map((path) => [
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
  const conversation: Project = {
    path: conversationPath,
    name: "对话",
    purpose: "conversation",
    lastActiveAt: 0,
    sessionCount: 0,
    pinned: false,
    exists: existsSync(conversationPath),
  };

  for (const session of sessions) {
    const project = session.projectPath === conversationPath ? conversation : byPath.get(session.projectPath);
    if (!project) continue;
    project.sessionCount += 1;
    project.lastActiveAt = Math.max(project.lastActiveAt, session.updatedAt);
  }

  // 旧版本按活动时间排序，切换到手动顺序时先按当时的活动时间落一次，避免列表突然变样
  if (!store.projects.ordered) {
    const byActivity = [...byPath.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    store.updateProjects((prefs) => ({ ...prefs, manual: byActivity.map((p) => p.path), ordered: true }));
  }

  // 置顶在前，其余保持用户拖动后的顺序（sort 是稳定的）
  const order = new Map(store.projects.manual.map((path, index) => [path, index]));
  const projects = [...byPath.values()].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0);
  });
  return [...projects, conversation];
}
