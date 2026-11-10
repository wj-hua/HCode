// 悬浮窗页面：默认收起为一条状态栏，点击展开任务列表，点击任务回到对应会话。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, GripVerticalIcon, LoaderIcon, MinusIcon } from "lucide-react";
import type { FloatingState, FloatingTask } from "@hcode/shared/types";
import { cn } from "@/components/lib/utils.js";
import { AgentBadge } from "../AgentBadge";
import { formatDuration } from "../format";
import { useUiStore } from "../store/uiStore";

// 悬浮窗只在本机 Electron 中打开，preload 一定注入了 hcode。
const hcode = window.hcode!;

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function elapsed(startedAt: number, now: number) {
  return startedAt ? formatDuration(Math.max(0, now - startedAt)) : "";
}

function StatusIcon({ awaiting }: { awaiting: boolean }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {awaiting ? (
        <span className="size-2 animate-pulse rounded-full bg-warning" />
      ) : (
        <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
      )}
    </span>
  );
}

function DragHandle() {
  return (
    <span className="app-drag flex h-full shrink-0 cursor-grab items-center pl-1.5 text-foreground-subtlest" title="拖动">
      <GripVerticalIcon className="size-3.5" />
    </span>
  );
}

function Pill({ tasks, now, onExpand }: { tasks: FloatingTask[]; now: number; onExpand(): void }) {
  const awaiting = tasks.filter((task) => task.awaiting).length;
  const known = tasks.map((task) => task.startedAt).filter(Boolean);
  const startedAt = known.length ? Math.min(...known) : 0;
  return (
    <div className="flex h-9 items-center">
      <DragHandle />
      {tasks.length === 0 ? (
        <div className="flex h-full items-center gap-2 pl-1.5 pr-3.5 text-ui-base">
          <CheckIcon className="size-4 text-success" />
          <span>任务已全部完成</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={onExpand}
          className="flex h-full items-center gap-2 pl-1.5 pr-3 text-ui-base outline-none"
        >
          <StatusIcon awaiting={awaiting > 0} />
          <span className={cn(awaiting > 0 && "text-warning")}>
            {awaiting > 0 ? `${awaiting} 个任务等待审批` : `${tasks.length} 个任务运行中`}
          </span>
          {startedAt > 0 && <span className="tabular-nums text-foreground-subtlest">{elapsed(startedAt, now)}</span>}
          <ChevronDownIcon className="size-3.5 text-foreground-subtle" />
        </button>
      )}
    </div>
  );
}

function TaskList({ tasks, now, onCollapse }: { tasks: FloatingTask[]; now: number; onCollapse(): void }) {
  return (
    <div className="w-80">
      <div className="app-drag flex h-9 cursor-grab items-center justify-between border-b border-border pl-3 pr-1.5">
        <span className="text-ui-sm font-medium text-foreground-subtle">HCode · {tasks.length} 个任务</span>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="收起"
          className="app-no-drag flex size-6 items-center justify-center rounded-md text-foreground-subtle hover:bg-surface-hover"
        >
          <MinusIcon className="size-3.5" />
        </button>
      </div>
      <ul className="max-h-80 space-y-0.5 overflow-y-auto p-1">
        {tasks.map((task) => (
          <li key={task.key}>
            <button
              type="button"
              onClick={() => void hcode.invoke("floating:open", task.viewId)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-surface-hover",
                task.awaiting && "bg-warning/10",
              )}
            >
              <StatusIcon awaiting={task.awaiting} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1.5">
                  {task.agents.map((agent, index) => (
                    <AgentBadge key={`${agent}-${index}`} agent={agent} />
                  ))}
                  <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">{task.title}</span>
                </span>
                <span className={cn("truncate text-ui-xs", task.awaiting ? "text-warning" : "text-foreground-subtlest")}>
                  {[task.awaiting ? "等待审批" : "运行中", elapsed(task.startedAt, now), task.projectName].filter(Boolean).join(" · ")}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FloatingApp() {
  const [state, setState] = useState<FloatingState>({ tasks: [], theme: "system" });
  const [expanded, setExpanded] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const { tasks } = state;
  const now = useNow(tasks.length > 0);
  const awaiting = tasks.some((task) => task.awaiting);

  useEffect(() => {
    void hcode.invoke("floating:getState").then(setState);
    return hcode.on("floating:state", setState);
  }, []);

  useEffect(() => useUiStore.getState().setTheme(state.theme), [state.theme]);

  // 窗口尺寸跟随卡片内容，避免透明区域挡住下面其他 App 的点击
  useLayoutEffect(() => {
    const card = cardRef.current!;
    const observer = new ResizeObserver(() => {
      void hcode.invoke("floating:resize", { width: card.offsetWidth, height: card.offsetHeight });
    });
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={cardRef}
      className={cn(
        "w-max select-none overflow-hidden rounded-xl border bg-background/95 text-foreground",
        awaiting ? "border-warning/60" : "border-border",
      )}
    >
      {expanded && tasks.length > 0 ? (
        <TaskList tasks={tasks} now={now} onCollapse={() => setExpanded(false)} />
      ) : (
        <Pill tasks={tasks} now={now} onExpand={() => setExpanded(true)} />
      )}
    </div>
  );
}
