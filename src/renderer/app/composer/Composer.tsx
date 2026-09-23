// 输入框：外观照 ZCode ChatPromptEditor（rounded-2xl bg-input + 底部工具栏）。
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardListIcon,
  CpuIcon,
  FilePenLineIcon,
  EyeIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AGENT_KINDS, AGENTS, type PermissionModeOption } from "@hcode/shared/agents";
import { AgentBadge } from "../AgentBadge";
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

const MODE_ICONS: Record<PermissionModeOption["icon"], ReactNode> = {
  shield: <ShieldCheckIcon className="size-4" />,
  edit: <FilePenLineIcon className="size-4" />,
  plan: <ClipboardListIcon className="size-4" />,
  readonly: <EyeIcon className="size-4" />,
  danger: <ShieldOffIcon className="size-4" />,
};

export function modeIcon(option: PermissionModeOption): ReactNode {
  return MODE_ICONS[option.icon];
}

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
  const setDraftAgent = useAppStore((state) => state.setDraftAgent);
  const loadModels = useAppStore((state) => state.loadModels);
  const agentStatuses = useAppStore((state) => state.agentStatuses);
  const models = useAppStore((state) => state.models[conversation.agent]) ?? AGENTS[conversation.agent].models;
  const isDraft = !conversation.sessionKey && !conversation.sessionId;
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

  useEffect(() => {
    void loadModels(conversation.agent);
  }, [conversation.agent, loadModels]);

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

  const agent = AGENTS[conversation.agent];
  const modeInfo =
    agent.permissionModes.find((item) => item.mode === conversation.permissionMode) ?? agent.permissionModes[0]!;
  const modelLabel = models.find((item) => item.value === conversation.model)?.label ?? conversation.model;

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
        placeholder={running ? `${agent.name} 正在工作…（Esc 停止）` : `给 ${agent.name} 发消息，Enter 发送，Shift+Enter 换行`}
        className="max-h-60 min-h-11 w-full resize-none bg-transparent px-1 text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest"
      />
      <div className="flex items-center gap-1.5">
        {isDraft ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-foreground">
                <AgentBadge agent={conversation.agent} />
                {agent.name}
                <ChevronDownIcon className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>使用的 CLI</DropdownMenuLabel>
              {AGENT_KINDS.map((kind) => {
                const status = agentStatuses?.find((item) => item.kind === kind);
                return (
                  <DropdownMenuItem
                    key={kind}
                    disabled={status !== undefined && !status.found}
                    onSelect={() => setDraftAgent(kind)}
                    className="gap-2"
                  >
                    <AgentBadge agent={kind} />
                    <span className="flex-1">{AGENTS[kind].name}</span>
                    {status && !status.found ? (
                      <span className="text-ui-sm text-foreground-subtlest">未安装</span>
                    ) : kind === conversation.agent ? (
                      <CheckIcon className="size-4" />
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                "gap-1.5 text-foreground-subtle",
                modeInfo.dangerous && "text-warning",
              )}
            >
              {modeIcon(modeInfo)}
              {modeInfo.label}
              <ChevronDownIcon className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel>权限模式</DropdownMenuLabel>
            {agent.permissionModes.map((item) => (
              <DropdownMenuItem
                key={item.mode}
                onSelect={() => void setPermissionMode(item.mode)}
                className="items-start gap-2"
              >
                <span className="mt-0.5">{modeIcon(item)}</span>
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
          <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
            <DropdownMenuLabel>模型</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {models.map((item) => (
              <DropdownMenuItem key={item.value} onSelect={() => void setModel(item.value)} className="items-start">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{item.label}</span>
                  {item.description ? (
                    <span className="truncate text-ui-sm text-foreground-subtle">{item.description}</span>
                  ) : null}
                </span>
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
