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
import { hcode } from "../bridge";
import { formatRelativeTime } from "../format";
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
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            onClick={() => !renaming && void openSession(session)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !renaming) void openSession(session);
            }}
            className={cn(
              "flex h-8 cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-2 transition-colors",
              isActive ? "bg-selected" : "hover:bg-surface-hover",
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {indicator === "running" ? (
                <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" />
              ) : indicator === "approval" ? (
                <span className="size-1.5 rounded-full bg-warning" title="等待审批" />
              ) : session.activeInTerminal ? (
                <span title="正在终端中运行">
                  <SquareTerminalIcon className="size-3.5 text-foreground-subtlest" />
                </span>
              ) : null}
            </span>
            {renaming ? (
              <RenameInput
                initial={session.title}
                onDone={(title) => {
                  setRenaming(false);
                  if (title && title !== session.title) void renameSession(session, title);
                }}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">{session.title}</span>
            )}
            {!renaming ? (
              <span className="shrink-0 text-ui-sm text-foreground-subtlest">
                {formatRelativeTime(session.updatedAt)}
              </span>
            ) : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <ContextMenuItem onSelect={() => setRenaming(true)}>重命名</ContextMenuItem>
          <ContextMenuItem onSelect={() => void hcode.invoke("app:copyText", session.id)}>
            复制会话 ID
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => void hcode.invoke("app:openInTerminal", session.projectPath, session.id)}
          >
            在终端中继续
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
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
      className="min-w-0 flex-1 rounded-md border border-input-border-focused bg-input px-1.5 text-ui-base text-foreground outline-none"
    />
  );
}
