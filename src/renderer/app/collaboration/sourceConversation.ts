// 恢复协作前将原生源会话绑定回当前视图，避免重开历史会话后丢失流式结果。
import type { CollaborationSnapshot } from "@hcode/shared/collaboration";
import { useAppStore } from "../store/appStore";
export function bindCollaborationSource(run: CollaborationSnapshot) {
  const initiator = run.params.initiator;
  const sourceId =
    initiator.resumeSessionId ??
    run.tasks.findLast(
      (task) => task.role === "planning" && task.nativeSessionId,
    )?.nativeSessionId;
  const views = Object.values(useAppStore.getState().conversations).filter(
    (view) =>
      view.agent === initiator.agent &&
      (view.sessionKey === initiator.sessionKey ||
        Boolean(sourceId && view.sessionId === sourceId)),
  );
  if (
    views.some(
      (view) =>
        view.runState === "running" ||
        view.runState === "awaitingApproval" ||
        view.queue.length,
    )
  )
    throw new Error("请先完成原会话的活动回合和消息队列");
  useAppStore.setState((state) => ({
    conversations: {
      ...state.conversations,
      ...Object.fromEntries(
        views.map((view) => [
          view.viewId,
          { ...view, sessionKey: initiator.sessionKey },
        ]),
      ),
    },
  }));
}
