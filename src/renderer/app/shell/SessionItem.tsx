import { LoaderIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@hcode/shared/types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { cn } from "@/components/lib/utils.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";
import { AgentBadge } from "../AgentBadge";
import { hcode } from "../bridge";
import { formatCompactRelativeTime } from "../format";
import { useAppStore } from "../store/appStore";

export function SessionItem({ session }: { session: SessionSummary }) {
  const openSession = useAppStore((state) => state.openSession);
  const renameSession = useAppStore((state) => state.renameSession);
  const conversation = useAppStore((state) =>
    Object.values(state.conversations).find((conv) => conv.sessionId === session.id),
  );
  const isActive = useAppStore(
    (state) => state.activeViewId !== null && state.activeViewId === conversation?.viewId,
  );
  const [renaming, setRenaming] = useState(false);

  const runState = conversation?.runState;
  const indicator =
    runState === "awaitingApproval" ? "approval" : runState === "running" ? "running" : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          data-task-item-key={session.id}
          tabIndex={0}
          onClick={() => !renaming && void openSession(session)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || renaming) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void openSession(session);
            }
          }}
          className={cn(
            "group/task-item flex cursor-pointer items-center gap-2 rounded-lg py-1 pl-2.5 pr-1 transition-[background-color,border-color,box-shadow]",
            isActive ? "bg-selected" : "hover:bg-surface-hover",
          )}
        >
          <div className="relative flex size-4 shrink-0 items-center justify-center">
            {indicator === "running" ? (
              <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
            ) : indicator === "approval" ? (
              <span className="h-1.5 w-1.5 rounded-full bg-warning" title="等待审批" />
            ) : session.activeInTerminal ? (
              <span title="正在终端中运行">
                <SquareTerminalIcon className="size-3.5 text-foreground-subtlest" />
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-w-0 items-center gap-2">
              <div className="relative flex h-6 min-w-0 flex-1 items-center gap-1.5">
                {renaming ? (
                  <RenameInput
                    initial={session.title}
                    onDone={(title) => {
                      setRenaming(false);
                      if (title && title !== session.title) void renameSession(session, title);
                    }}
                  />
                ) : (
                  <TaskTitleOverflowText className="text-ui-base text-foreground">
                    {session.title}
                  </TaskTitleOverflowText>
                )}
              </div>
              {!renaming ? (
                <span className="mr-0.5 flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
                  {/* 左侧 16px 槽只放状态（与 ZCode 一致，空闲时留空以体现层级）；CLI 徽标归入右侧元信息。 */}
                  <AgentBadge agent={session.agent} className="opacity-70" />
                  {formatCompactRelativeTime(session.updatedAt)}
                </span>
              ) : null}
            </div>
          </div>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem onSelect={() => setRenaming(true)}>重命名</ContextMenuItem>
        <ContextMenuItem onSelect={() => void hcode.invoke("app:copyText", session.id)}>
          复制会话 ID
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => void hcode.invoke("app:openInTerminal", session.projectPath, { agent: session.agent, id: session.id })}
        >
          在终端中继续
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (title: string) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => onDone(value.trim())}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") onDone(value.trim());
        if (event.key === "Escape") onDone(initial);
      }}
      className="h-6 min-w-0 flex-1 rounded-md border border-input-border-focused bg-input px-1.5 text-ui-base text-foreground outline-none"
    />
  );
}
