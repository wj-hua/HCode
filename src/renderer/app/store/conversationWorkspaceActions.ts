// 非项目对话入口：先解析主进程管理的目录，再通过现有草稿动作切换，保留输入与 CLI 设置。
import { hcode } from "../bridge";
import type { AppState } from "./appStore";

type WorkspaceState = Pick<AppState, "activeViewId" | "conversations" | "refreshProjects" | "newChat" | "setDraftProject" | "toggleProject">;

/** 异步创建期间用户切到别处时放弃导航；已发送的会话不能改工作目录。 */
export async function selectConversationWorkspace(get: () => WorkspaceState, newDraft: boolean): Promise<void> {
  const originalViewId = get().activeViewId;
  const path = await hcode.invoke("workspace:conversation");
  await get().refreshProjects();
  const state = get();
  if (state.activeViewId !== originalViewId) return;
  const active = originalViewId ? state.conversations[originalViewId] : undefined;
  if (!newDraft && active && !active.sessionId && !active.sessionKey && !active.compareId) {
    state.setDraftProject(path);
    if (active.projectPath === path) state.toggleProject(path, true);
  } else {
    state.newChat(path);
    state.toggleProject(path, true);
  }
}
