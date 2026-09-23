// 输入框：外观照 ZCode ChatPromptEditor（rounded-2xl bg-input + 底部工具栏）。
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardListIcon,
  CpuIcon,
  FilePenLineIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { PermissionMode } from "@hcode/shared/types";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useAppStore, type Conversation } from "../store/appStore";

export const PERMISSION_MODES: {
  mode: PermissionMode;
  label: string;
  description: string;
  icon: ReactNode;
}[] = [
  {
    mode: "default",
    label: "逐条审批",
    description: "修改文件、执行命令前都会询问你",
    icon: <ShieldCheckIcon className="size-4" />,
  },
  {
    mode: "acceptEdits",
    label: "自动接受编辑",
    description: "文件修改自动通过，命令仍需审批",
    icon: <FilePenLineIcon className="size-4" />,
  },
  {
    mode: "plan",
    label: "计划模式",
    description: "只读分析并给出计划，批准后才执行",
    icon: <ClipboardListIcon className="size-4" />,
  },
  {
    mode: "bypassPermissions",
    label: "完全放行",
    description: "不再询问任何操作（谨慎使用）",
    icon: <ShieldOffIcon className="size-4" />,
  },
];

export const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "默认模型" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

// 切换会话时保留各自未发送的草稿
const drafts = new Map<string, string>();

export function Composer({
  conversation,
  onSubmitted,
}: {
  conversation: Conversation;
  onSubmitted: () => void;
}) {
  const send = useAppStore((state) => state.send);
  const interrupt = useAppStore((state) => state.interrupt);
  const setPermissionMode = useAppStore((state) => state.setPermissionMode);
  const setModel = useAppStore((state) => state.setModel);
  const [text, setText] = useState(() => drafts.get(conversation.viewId) ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const running = conversation.runState === "running" || conversation.runState === "awaitingApproval";
  const activeInTerminal = useAppStore(
    (state) =>
      !conversation.sessionKey &&
      Boolean(
        conversation.sessionId &&
          state.sessions[conversation.projectPath]?.find((item) => item.id === conversation.sessionId)
            ?.activeInTerminal,
      ),
  );

  useEffect(() => {
    drafts.set(conversation.viewId, text);
  }, [conversation.viewId, text]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [conversation.viewId]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = () => {
    if (!text.trim() || running || conversation.loading) return;
    void send(text);
    setText("");
    drafts.delete(conversation.viewId);
    onSubmitted();
  };

  const modeInfo = PERMISSION_MODES.find((item) => item.mode === conversation.permissionMode) ?? PERMISSION_MODES[0]!;
  const modelLabel =
    MODEL_OPTIONS.find((item) => item.value === conversation.model)?.label ?? conversation.model;

  return (
    <>
    {activeInTerminal ? (
      <div className="mb-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-ui-sm text-foreground-subtle">
        这个会话正在某个终端的 claude 中运行。在这里继续发送会与终端同时写入同一会话，建议先在终端里退出。
      </div>
    ) : null}
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-input-border bg-input p-3 transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused focus-within:bg-input-focused"
    >
      <textarea
        ref={textareaRef}
        value={text}
        rows={2}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape" && running) {
            event.preventDefault();
            void interrupt();
          }
        }}
        placeholder={running ? "Claude 正在工作…（Esc 停止）" : "给 Claude 发消息，Enter 发送，Shift+Enter 换行"}
        className="max-h-60 min-h-11 w-full resize-none bg-transparent px-1 text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest"
      />
      <div className="flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "gap-1.5 text-foreground-subtle",
                conversation.permissionMode === "bypassPermissions" && "text-warning",
              )}
            >
              {modeInfo.icon}
              {modeInfo.label}
              <ChevronDownIcon className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel>权限模式</DropdownMenuLabel>
            {PERMISSION_MODES.map((item) => (
              <DropdownMenuItem
                key={item.mode}
                onSelect={() => void setPermissionMode(item.mode)}
                className="items-start gap-2"
              >
                <span className="mt-0.5">{item.icon}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{item.label}</span>
                  <span className="text-ui-sm text-foreground-subtle">{item.description}</span>
                </span>
                {item.mode === conversation.permissionMode ? <CheckIcon className="mt-0.5 size-4" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-foreground-subtle">
              <CpuIcon className="size-4" />
              {conversation.model ? modelLabel : conversation.activeModel ?? modelLabel}
              <ChevronDownIcon className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuLabel>模型</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {MODEL_OPTIONS.map((item) => (
              <DropdownMenuItem key={item.value} onSelect={() => void setModel(item.value)}>
                <span className="flex-1">{item.label}</span>
                {item.value === conversation.model ? <CheckIcon className="size-4" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex-1" />
        {running ? (
          <ControlHintTooltip title="停止" shortcut="Esc">
            <Button
              type="button"
              size="icon-md"
              onClick={() => void interrupt()}
              className="rounded-lg bg-foreground text-background hover:bg-foreground/80"
            >
              <SquareIcon className="size-3.5 fill-current" />
            </Button>
          </ControlHintTooltip>
        ) : (
          <ControlHintTooltip title="发送" shortcut="Enter">
            <Button
              type="submit"
              size="icon-md"
              disabled={!text.trim() || conversation.loading}
              className="rounded-lg bg-brand text-foreground-inverse hover:bg-brand/80"
            >
              <ArrowUpIcon className="size-4" />
            </Button>
          </ControlHintTooltip>
        )}
      </div>
    </form>
    </>
  );
}
