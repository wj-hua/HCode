// 运行中任务汇总：侧边栏“运行中”区块与悬浮窗共用。
import { useEffect } from "react";
import type { FloatingTask, Project } from "@hcode/shared/types";
import { isRemote, hcode } from "../bridge";
import { conversationTitle, useAppStore, type Conversation } from "../store/appStore";
import { usePresentationStore } from "../collaboration/presentationStore";

/** 正在执行或等待审批的会话，对比组合并为一行；等待审批的排前面。startedAt 为 0 表示未知。 */
export function collectRunningTasks(conversations: Record<string, Conversation>, projects: readonly Project[]): FloatingTask[] {
  const busy = Object.values(conversations).filter(
    (conv) => conv.runState === "running" || conv.runState === "awaitingApproval" || !!conv.backgroundTasks,
  );
  const groups = new Map<string, Conversation[]>();
  for (const conv of busy) {
    const key = conv.compareId ?? conv.viewId;
    groups.set(key, [...(groups.get(key) ?? []), conv]);
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const target = list.find((conv) => conv.runState === "awaitingApproval") ?? list[0]!;
      const startedAt = Math.min(...list.map((conv) => conv.runStartedAt ?? Infinity));
      return {
        key,
        viewId: target.viewId,
        agents: list.map((conv) => conv.agent),
        title: conversationTitle(target),
        projectName: projects.find((project) => project.path === target.projectPath)?.name ?? target.projectPath,
        awaiting: list.some((conv) => conv.runState === "awaitingApproval"),
        startedAt: Number.isFinite(startedAt) ? startedAt : 0,
      };
    })
    .sort((a, b) => Number(b.awaiting) - Number(a.awaiting) || a.startedAt - b.startedAt);
}

/** 本机主窗口把运行中任务同步给主进程，由主进程决定悬浮窗显隐；远程页面不参与。 */
export function useFloatingTasksSync() {
  useEffect(() => {
    if (isRemote) return;
    let last = "";
    const push = () => {
      const { conversations, projects } = useAppStore.getState();
      const tasks = collectRunningTasks(conversations, projects);
      const json = JSON.stringify(tasks);
      if (json === last) return;
      last = json;
      void hcode.invoke("floating:setTasks", tasks);
    };
    push();
    const offApp = useAppStore.subscribe(push);
    const offPresentation = usePresentationStore.subscribe(push);
    return () => {
      offApp();
      offPresentation();
    };
  }, []);
}
