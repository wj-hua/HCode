// 侧边栏“运行中”区块：跨项目汇总正在执行或等待审批的会话，点击跳转。
import { useEffect, useMemo, useState } from "react";
import { LoaderIcon } from "lucide-react";
import type { AgentKind } from "@hcode/shared/types";
import { cn } from "@/components/lib/utils.js";
import { AgentBadge } from "../AgentBadge";
import { formatDuration } from "../format";
import { conversationTitle, useAppStore } from "../store/appStore";

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatDuration(Math.max(0, now - since))}</>;
}

export function RunningTasks() {
  const conversations = useAppStore((state) => state.conversations);
  const projects = useAppStore((state) => state.projects);
  const activeViewId = useAppStore((state) => state.activeViewId);
  const activateView = useAppStore((state) => state.activateView);

  const tasks = useMemo(() => {
    const busy = Object.values(conversations).filter(
      (conv) => conv.runState === "running" || conv.runState === "awaitingApproval",
    );
    const groups = new Map<string, typeof busy>();
    for (const conv of busy) {
      // 对比组合并为一行
      const key = conv.compareId ?? conv.viewId;
      groups.set(key, [...(groups.get(key) ?? []), conv]);
    }
    return [...groups.entries()]
      .map(([key, list]) => {
        const target = list.find((conv) => conv.runState === "awaitingApproval") ?? list[0]!;
        return {
          key,
          viewId: target.viewId,
          agents: list.map((conv) => conv.agent) as AgentKind[],
          title: conversationTitle(target),
          projectName: projects.find((project) => project.path === target.projectPath)?.name ?? target.projectPath,
          awaiting: list.some((conv) => conv.runState === "awaitingApproval"),
          startedAt: Math.min(...list.map((conv) => conv.runStartedAt ?? Date.now())),
          active: list.some((conv) => conv.viewId === activeViewId),
        };
      })
      .sort((a, b) => Number(b.awaiting) - Number(a.awaiting) || a.startedAt - b.startedAt);
  }, [conversations, projects, activeViewId]);

  if (tasks.length === 0) return null;

  return (
    <section aria-label="运行中">
      <div className="flex h-7 items-center px-2.5 text-ui-base font-medium text-foreground-subtlest">
        运行中 · {tasks.length}
      </div>
      <ul className="space-y-0.5">
        {tasks.map((task) => (
          <li
            key={task.key}
            tabIndex={0}
            onClick={() => activateView(task.viewId)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activateView(task.viewId);
              }
            }}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-lg py-1 pl-2.5 pr-2 transition-colors",
              task.active ? "bg-selected" : "hover:bg-surface-hover",
            )}
          >
            <div className="flex size-4 shrink-0 items-center justify-center">
              {task.awaiting ? (
                <span className="h-1.5 w-1.5 rounded-full bg-warning" title="等待审批" />
              ) : (
                <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-w-0 items-center gap-1.5">
                {task.agents.map((agent, index) => (
                  <AgentBadge key={`${agent}-${index}`} agent={agent} />
                ))}
                <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">{task.title}</span>
              </div>
              <span className={cn("truncate text-ui-xs", task.awaiting ? "text-warning" : "text-foreground-subtlest")}>
                {task.awaiting ? "等待审批" : "运行中"} · <Elapsed since={task.startedAt} /> · {task.projectName}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
