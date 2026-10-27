import { CheckCircle2Icon, CircleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentBadge } from "../AgentBadge";
import { formatRelativeTime } from "../format";
import { conversationTitle, useAppStore } from "../store/appStore";

/** 本次运行中最近结束的会话，保留在侧栏以便回看。 */
export function RecentTasks() {
  const tasks = useAppStore((state) => state.recentTasks);
  const conversations = useAppStore((state) => state.conversations);
  const sessions = useAppStore((state) => state.sessions);
  const projects = useAppStore((state) => state.projects);
  const activeViewId = useAppStore((state) => state.activeViewId);
  const activateView = useAppStore((state) => state.activateView);
  const openSession = useAppStore((state) => state.openSession);
  const loadSessions = useAppStore((state) => state.loadSessions);
  const [now, setNow] = useState(Date.now());
  const requested = useRef(new Set<string>());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    for (const task of Object.values(tasks)) {
      const key = `${task.sessionKey}:${task.completedAt}`;
      if (!requested.current.has(key) && projects.some((project) => project.path === task.projectPath)) {
        requested.current.add(key);
        if (!(sessions[task.projectPath] ?? []).some((item) => item.agent === task.agent && item.id === task.sessionId)) void loadSessions(task.projectPath);
      }
    }
  }, [tasks, sessions, projects, loadSessions]);

  const recent = Object.values(tasks).filter((task) => task.sessionId && projects.some((project) => project.path === task.projectPath)
    && (Object.values(conversations).some((item) => item.agent === task.agent && item.projectPath === task.projectPath && item.sessionId === task.sessionId)
      || (sessions[task.projectPath] ?? []).some((item) => item.agent === task.agent && item.id === task.sessionId)))
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  if (!recent.length) return null;
  return <section aria-label="最近完成">
    <div className="flex h-7 items-center px-2.5 text-ui-base font-medium text-foreground-subtlest">最近完成 · {recent.length}</div>
    <ul className="space-y-0.5">
      {recent.map((task) => {
        const conv = Object.values(conversations).find((item) => item.agent === task.agent && item.projectPath === task.projectPath && item.sessionId === task.sessionId);
        const summary = (sessions[task.projectPath] ?? []).find((item) => item.agent === task.agent && item.id === task.sessionId);
        const projectName = projects.find((project) => project.path === task.projectPath)?.name ?? task.projectPath;
        const title = conv ? conversationTitle(conv) : summary?.title ?? "会话";
        const failed = task.state === "error";
        return <li key={task.sessionKey}>
          <button type="button" className={`flex w-full items-center gap-2 rounded-lg py-1 pl-2.5 pr-2 text-left ${conv?.viewId === activeViewId ? "bg-selected" : "hover:bg-surface-hover"}`}
            onClick={() => {
              if (conv) activateView(conv.viewId);
              else void openSession(summary ?? { id: task.sessionId!, agent: task.agent, projectPath: task.projectPath, title, createdAt: task.completedAt!, updatedAt: task.completedAt! });
            }}>
            {failed ? <CircleAlertIcon className="size-4 shrink-0 text-destructive" /> : <CheckCircle2Icon className="size-4 shrink-0 text-foreground-subtle" />}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1.5"><AgentBadge agent={task.agent} /><span className="truncate text-ui-base text-foreground">{title}</span></span>
              <span className="truncate text-ui-xs text-foreground-subtlest">{failed ? "出错" : "已完成"} · {formatRelativeTime(task.completedAt!, now)} · {projectName}</span>
            </span>
          </button>
        </li>;
      })}
    </ul>
  </section>;
}
