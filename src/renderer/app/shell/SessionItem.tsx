import { LoaderIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@hcode/shared/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
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
import { toast } from "@/components/ui/toast.js";
import { hcode } from "../bridge";
import { conversationToMarkdown, markdownFileName } from "../exportMarkdown";
import { formatCompactRelativeTime } from "../format";
import { errorMessage, useAppStore } from "../store/appStore";

export function SessionItem({ session }: { session: SessionSummary }) {
  const openSession = useAppStore((state) => state.openSession);
  const renameSession = useAppStore((state) => state.renameSession);
  const deleteSession = useAppStore((state) => state.deleteSession);
  const conversation = useAppStore((state) =>
    Object.values(state.conversations).find((conv) => conv.sessionId === session.id),
  );
  const isActive = useAppStore(
    (state) => state.activeViewId !== null && state.activeViewId === conversation?.viewId,
  );
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const runState = conversation?.runState;
  const indicator =
    runState === "awaitingApproval" ? "approval" : runState === "running" ? "running" : null;
  // Codex 只能归档；运行中（HCode 或终端里）的会话不能删除，否则 CLI 会继续写会话文件
  const deleteLabel = session.agent === "codex" ? "归档" : "删除";
  const deleteDisabled = indicator !== null || session.activeInTerminal === true;

  // 已打开的会话直接用界面上的行，否则从 CLI 的会话文件读取
  const exportMarkdown = async (mode: "save" | "copy") => {
    try {
      const rows = conversation?.rows.length
        ? conversation.rows
        : (await hcode.invoke("sessions:load", { agent: session.agent, id: session.id, projectPath: session.projectPath })).rows;
      const markdown = conversationToMarkdown(session, rows);
      if (mode === "copy") {
        await hcode.invoke("app:copyText", markdown);
        toast("已复制为 Markdown");
      } else {
        const path = await hcode.invoke("app:saveText", markdownFileName(session.title), markdown);
        if (path) toast("已导出 Markdown");
      }
    } catch (error) {
      toast(`导出失败：${errorMessage(error)}`, { variant: "warning" });
    }
  };

  return (
    <>
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
          <ContextMenuItem onSelect={() => void exportMarkdown("save")}>导出为 Markdown…</ContextMenuItem>
          <ContextMenuItem onSelect={() => void exportMarkdown("copy")}>复制为 Markdown</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => void hcode.invoke("app:openInTerminal", session.projectPath, { agent: session.agent, id: session.id })}
          >
            在终端中继续
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            disabled={deleteDisabled}
            onSelect={() => setConfirmingDelete(true)}
          >
            {deleteDisabled ? `${deleteLabel}会话（运行中不可${deleteLabel}）` : `${deleteLabel}会话`}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteLabel}会话？</AlertDialogTitle>
            <AlertDialogDescription>
              {session.agent === "codex"
                ? `「${session.title}」归档后不再出现在 HCode 与 Codex 的会话列表中。`
                : `「${session.title}」的会话文件将移到废纸篓，可从废纸篓恢复。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void deleteSession(session)}>
              {deleteLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
