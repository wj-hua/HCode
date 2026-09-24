// 输入框：外观照 ZCode ChatPromptEditor（rounded-2xl bg-input + 底部工具栏）。
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardListIcon,
  CpuIcon,
  FilePenLineIcon,
  EyeIcon,
  ImagePlusIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AGENT_KINDS, AGENTS, type PermissionModeOption } from "@hcode/shared/agents";
import type { ImageInput } from "@hcode/shared/types";
import { AgentBadge } from "../AgentBadge";
import { DraftContextBar } from "./DraftContextBar";
import { ImageAttachments } from "../ImageAttachments";
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
import { toast } from "@/components/ui/toast.js";
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
const imageDrafts = new Map<string, ImageInput[]>();

// 三个 CLI 的模型都支持的图片格式；5MB 是 Claude API 的单图上限
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function readImage(file: File): Promise<ImageInput> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ data: url.slice(url.indexOf(",") + 1), mimeType: file.type, name: file.name || "图片" });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

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
  const [images, setImages] = useState<ImageInput[]>(() => imageDrafts.get(conversation.viewId) ?? []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    imageDrafts.set(conversation.viewId, images);
  }, [conversation.viewId, images]);

  /** 粘贴、拖入、选择文件共用：过滤格式与大小，读成 base64 追加到待发送列表。 */
  const addImages = async (files: readonly File[]) => {
    const accepted = files.filter((file) => {
      if (!IMAGE_TYPES.includes(file.type)) {
        toast(`不支持的图片格式：${file.name || file.type}（支持 PNG、JPEG、GIF、WebP）`, { variant: "warning" });
        return false;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast(`图片超过 5MB：${file.name}`, { variant: "warning" });
        return false;
      }
      return true;
    });
    if (accepted.length === 0) return;
    const read = await Promise.all(accepted.map(readImage));
    setImages((current) => [...current, ...read]);
  };

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

  const canSend = Boolean(text.trim() || images.length > 0);

  const submit = () => {
    if (!canSend || running || conversation.loading) return;
    void send(text, images);
    setText("");
    setImages([]);
    drafts.delete(conversation.viewId);
    imageDrafts.delete(conversation.viewId);
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
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = [...event.dataTransfer.files];
        if (files.length === 0) return;
        event.preventDefault();
        void addImages(files);
      }}
      className="relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-input-border bg-input p-3 transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused focus-within:bg-input-focused"
    >
      <ImageAttachments
        images={images.map((image) => ({ src: `data:${image.mimeType};base64,${image.data}`, name: image.name ?? "图片" }))}
        onRemove={(index) => setImages((current) => current.filter((_, i) => i !== index))}
        className="px-1"
      />
      <textarea
        ref={textareaRef}
        value={text}
        rows={2}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
          if (files.length === 0) return;
          event.preventDefault();
          void addImages(files);
        }}
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
        <input
          ref={fileInputRef}
          type="file"
          accept={IMAGE_TYPES.join(",")}
          multiple
          hidden
          onChange={(event) => {
            void addImages([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <ControlHintTooltip title="添加图片（也可以粘贴或拖入）">
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            onClick={() => fileInputRef.current?.click()}
            className="text-foreground-subtle"
          >
            <ImagePlusIcon className="size-4" />
          </Button>
        </ControlHintTooltip>
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
              disabled={!canSend || conversation.loading}
              className="rounded-lg bg-brand text-foreground-inverse hover:bg-brand/80"
            >
              <ArrowUpIcon className="size-4" />
            </Button>
          </ControlHintTooltip>
        )}
      </div>
    </form>
    {isDraft ? <DraftContextBar conversation={conversation} /> : null}
    </>
  );
}
