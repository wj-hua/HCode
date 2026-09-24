// 输入框：外观照 ZCode ChatPromptEditor（rounded-2xl bg-input + 底部工具栏）。
import {
  ArrowUpIcon,
  ChevronDownIcon,
  ClipboardListIcon,
  FilePenLineIcon,
  EyeIcon,
  PlusIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ZCodeConfigOption } from "@zcode/shared";
import { AGENT_KINDS, AGENTS, type PermissionModeOption } from "@hcode/shared/agents";
import type { FileInput, ImageInput } from "@hcode/shared/types";
import { AgentBadge } from "../AgentBadge";
import { DraftContextBar } from "./DraftContextBar";
import { ImageAttachments } from "../ImageAttachments";
import { FileAttachments } from "../FileAttachments";
import { hcode } from "../bridge";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { appendPromptHistoryEntry, navigatePromptHistory } from "@/lib/promptHistory.js";
import { persistPromptHistoryEntries, readPromptHistoryEntries } from "@/lib/promptHistoryStorage.js";
import { modelEfforts, useAppStore, type Conversation } from "../store/appStore";

const MODE_ICONS = {
  shield: ShieldCheckIcon,
  edit: FilePenLineIcon,
  plan: ClipboardListIcon,
  readonly: EyeIcon,
  danger: ShieldOffIcon,
} satisfies Record<PermissionModeOption["icon"], unknown>;

export function modeIcon(option: PermissionModeOption, className = "size-4"): ReactNode {
  const Icon = MODE_ICONS[option.icon];
  return <Icon className={className} />;
}

/** 下拉菜单关闭后把焦点还给输入框（照 ZCode 的 focusSelectorOnClose）。 */
const COMPOSER_INPUT_SELECTOR = "[data-composer-input]";
/** Radix 的选项值不能为空串，「默认模型」用占位值代替。 */
const DEFAULT_MODEL_VALUE = "__default__";

// 切换会话时保留各自未发送的草稿
const drafts = new Map<string, string>();
const imageDrafts = new Map<string, ImageInput[]>();
const fileDrafts = new Map<string, FileInput[]>();

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

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取附件失败"));
    reader.readAsDataURL(file);
  });
}

const isModelLocked = () => false;

function restoreInputFocus(event: Event) {
  event.preventDefault();
  document.querySelector<HTMLElement>(COMPOSER_INPUT_SELECTOR)?.focus();
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
  const setEffort = useAppStore((state) => state.setEffort);
  const setDraftAgent = useAppStore((state) => state.setDraftAgent);
  const loadModels = useAppStore((state) => state.loadModels);
  const agentStatuses = useAppStore((state) => state.agentStatuses);
  const models = useAppStore((state) => state.models[conversation.agent]) ?? AGENTS[conversation.agent].models;
  const isDraft = !conversation.sessionKey && !conversation.sessionId;
  const [text, setText] = useState(() => drafts.get(conversation.viewId) ?? "");
  const [images, setImages] = useState<ImageInput[]>(() => imageDrafts.get(conversation.viewId) ?? []);
  const [files, setFiles] = useState<FileInput[]>(() => fileDrafts.get(conversation.viewId) ?? []);
  const [adding, setAdding] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const thoughtTriggerRef = useRef<HTMLSpanElement>(null);
  const { intl } = useZCodeIntl();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // ↑/↓ 历史输入：照 ZCode PromptHistoryPlugin，按项目存 localStorage；index 为 null 表示不在历史浏览态
  const [promptHistory, setPromptHistory] = useState<readonly string[]>(() =>
    readPromptHistoryEntries(conversation.projectPath),
  );
  const historyIndexRef = useRef<number | null>(null);
  const caretToEndRef = useRef(false);
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

  useEffect(() => {
    fileDrafts.set(conversation.viewId, files);
  }, [conversation.viewId, files]);

  /** 本地文件只传路径；剪贴板文件没有路径时暂存到 HCode 数据目录。 */
  const addFiles = async (selected: readonly File[]) => {
    if (selected.length === 0) return;
    setAdding((count) => count + 1);
    try {
      const results = await Promise.allSettled(selected.map(async (file) => {
        if (IMAGE_TYPES.includes(file.type)) {
          if (file.size > MAX_IMAGE_BYTES) throw new Error(`图片超过 5MB：${file.name}`);
          return { image: await readImage(file) };
        }
        const localPath = hcode.getPathForFile(file);
        if (!localPath && file.size > 20 * 1024 * 1024) throw new Error(`剪贴板附件超过 20MB：${file.name}`);
        const path = localPath ?? await hcode.invoke("fs:stageAttachment", { name: file.name, data: await readBase64(file) });
        return { file: { path, name: file.name || "附件", mimeType: file.type || "application/octet-stream", size: file.size } satisfies FileInput };
      }));
      const nextImages: ImageInput[] = [];
      const nextFiles: FileInput[] = [];
      for (const result of results) {
        if (result.status === "rejected") {
          toast(result.reason instanceof Error ? result.reason.message : String(result.reason), { variant: "warning" });
        } else if ("image" in result.value && result.value.image) {
          nextImages.push(result.value.image);
        } else if ("file" in result.value && result.value.file) {
          nextFiles.push(result.value.file);
        }
      }
      if (nextImages.length) setImages((current) => [...current, ...nextImages]);
      if (nextFiles.length) setFiles((current) => [...current, ...nextFiles]);
    } finally {
      setAdding((count) => count - 1);
    }
  };

  useEffect(() => {
    textareaRef.current?.focus();
  }, [conversation.viewId]);

  useEffect(() => {
    setPromptHistory(readPromptHistoryEntries(conversation.projectPath));
    historyIndexRef.current = null;
  }, [conversation.projectPath]);

  useEffect(() => {
    void loadModels(conversation.agent);
  }, [conversation.agent, loadModels]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    if (caretToEndRef.current) {
      caretToEndRef.current = false;
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [text]);

  const canSend = Boolean(text.trim() || images.length > 0 || files.length > 0);

  const submit = () => {
    if (!canSend || running || conversation.loading || adding || submitting) return;
    setSubmitting(true);
    const projectPath = conversation.projectPath;
    void send(text, images, files).then((sent) => {
      if (!sent) return;
      const nextHistory = appendPromptHistoryEntry(readPromptHistoryEntries(projectPath), text);
      persistPromptHistoryEntries(projectPath, nextHistory);
      setPromptHistory(nextHistory);
      historyIndexRef.current = null;
      setText((current) => current === text ? "" : current);
      setImages((current) => current === images ? [] : current);
      setFiles((current) => current === files ? [] : current);
      onSubmitted();
    }).finally(() => setSubmitting(false));
  };

  const agent = AGENTS[conversation.agent];
  const modeInfo =
    agent.permissionModes.find((item) => item.mode === conversation.permissionMode) ?? agent.permissionModes[0]!;
  const modelLabel = models.find((item) => item.value === conversation.model)?.label ?? conversation.model;
  const modelGroups = useMemo<ModelSelectGroup[]>(
    () => [
      {
        key: conversation.agent,
        label: AGENTS[conversation.agent].name,
        items: models.map((item) => ({
          key: item.value || DEFAULT_MODEL_VALUE,
          value: item.value || DEFAULT_MODEL_VALUE,
          name: item.label,
        })),
      },
    ],
    [conversation.agent, models],
  );
  // 思考强度照 ZCode：候选档位来自当前模型，未选或当前模型不支持时显示占位
  const efforts = modelEfforts(models, conversation.model);
  const thoughtOption = useMemo<ZCodeConfigOption | null>(
    () =>
      efforts.length > 0
        ? {
            id: "thought_level",
            name: "思考强度",
            category: "thought_level",
            type: "select",
            currentValue: efforts.includes(conversation.effort) ? conversation.effort : "",
            options: efforts.map((value) => ({ value, name: value })),
          }
        : null,
    [efforts.join(), conversation.effort],
  );

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
        void addFiles(files);
      }}
      className="relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-input-border bg-input p-3 transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused focus-within:bg-input-focused"
    >
      <ImageAttachments
        images={images.map((image) => ({ src: `data:${image.mimeType};base64,${image.data}`, name: image.name ?? "图片" }))}
        onRemove={(index) => setImages((current) => current.filter((_, i) => i !== index))}
      />
      <FileAttachments files={files} onRemove={(index) => setFiles((current) => current.filter((_, i) => i !== index))} />
      <textarea
        ref={textareaRef}
        value={text}
        rows={1}
        data-composer-input
        onChange={(event) => {
          const index = historyIndexRef.current;
          // 手动改过回填的历史后退出浏览态，上下键恢复为移动光标
          if (index !== null && event.target.value !== promptHistory[index]) historyIndexRef.current = null;
          setText(event.target.value);
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length === 0) return;
          event.preventDefault();
          void addFiles(files);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape" && running) {
            event.preventDefault();
            void interrupt();
          } else if (
            (event.key === "ArrowUp" || event.key === "ArrowDown") &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            !event.nativeEvent.isComposing
          ) {
            // 只在空输入或已处于历史浏览态时接管上下键，避免抢走多行输入的光标移动
            if (historyIndexRef.current === null && text.length > 0) return;
            const result = navigatePromptHistory(promptHistory, historyIndexRef.current, event.key === "ArrowUp" ? "up" : "down");
            if (!result.shouldHandle) return;
            event.preventDefault();
            historyIndexRef.current = result.nextIndex;
            if (result.nextValue !== text) {
              caretToEndRef.current = true;
              setText(result.nextValue);
            }
          }
        }}
        placeholder={running ? `${agent.name} 正在工作…（Esc 停止）` : `给 ${agent.name} 发消息，Enter 发送，Shift+Enter 换行`}
        className="max-h-40 min-h-10 w-full resize-none overflow-y-auto bg-transparent text-ui-base leading-5 text-foreground outline-none placeholder:text-foreground-subtlest"
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void addFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      {/* 工具条照 ZCode ChatPromptEditor：左侧 + / CLI / 权限模式，右侧模型 / 思考强度 / 发送 */}
      <div className="group/toolbar flex items-end gap-3">
        <div className="flex min-w-0 flex-1 items-center">
          <div className="flex shrink-0 items-center gap-1">
            <ControlHintTooltip title="添加附件（图片、视频、文档等；也可以粘贴或拖入）">
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                className="gap-1 rounded-lg text-ui-base"
                onClick={() => fileInputRef.current?.click()}
                aria-label="添加附件"
              >
                <PlusIcon className="size-4" />
              </Button>
            </ControlHintTooltip>
            {isDraft ? (
              <DropdownMenu>
                <ControlHintTooltip title="使用的 CLI">
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 rounded-lg px-2 text-ui-base">
                      <AgentBadge agent={conversation.agent} />
                      {agent.name}
                      <ChevronDownIcon className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </ControlHintTooltip>
                <DropdownMenuContent side="top" align="start" sideOffset={4} className="w-56" onCloseAutoFocus={restoreInputFocus}>
                  <DropdownMenuLabel>使用的 CLI</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={conversation.agent}>
                    {AGENT_KINDS.map((kind) => {
                      const status = agentStatuses?.find((item) => item.kind === kind);
                      const missing = status !== undefined && !status.found;
                      return (
                        <DropdownMenuRadioItem
                          key={kind}
                          value={kind}
                          disabled={missing}
                          onSelect={() => setDraftAgent(kind)}
                          className="min-h-8 gap-2"
                        >
                          <AgentBadge agent={kind} />
                          <span className="flex-1">{AGENTS[kind].name}</span>
                          {missing ? <span className="text-ui-sm text-foreground-subtlest">未安装</span> : null}
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <DropdownMenu>
              <ControlHintTooltip title="权限模式">
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "h-7 gap-1 rounded-lg px-2 text-ui-base",
                      modeInfo.dangerous && "text-warning hover:text-warning",
                    )}
                  >
                    {modeIcon(modeInfo)}
                    {modeInfo.label}
                    <ChevronDownIcon className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </ControlHintTooltip>
              <DropdownMenuContent side="top" align="start" sideOffset={4} className="w-64" onCloseAutoFocus={restoreInputFocus}>
                <DropdownMenuRadioGroup
                  value={conversation.permissionMode}
                  onValueChange={(mode) => void setPermissionMode(mode)}
                >
                  {agent.permissionModes.map((item) => (
                    <DropdownMenuRadioItem key={item.mode} value={item.mode} className="min-h-13 items-start gap-3 py-2">
                      <span className="mt-0.5">{modeIcon(item, "size-4.5 shrink-0")}</span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span>{item.label}</span>
                        <span className="text-ui-sm text-foreground-subtle">{item.description}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5">
          <div className="flex min-w-0 items-center gap-1">
            <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden empty:hidden">
              <ModelConfigSelect
                modelGroups={modelGroups}
                showProviderLevel={false}
                normalizedValue={conversation.model || DEFAULT_MODEL_VALUE}
                triggerLabel={conversation.model ? modelLabel : conversation.activeModel ?? modelLabel}
                showManageModelsAction={false}
                lockReasonMessage=""
                isItemLocked={isModelLocked}
                onValueChange={(value) => void setModel(value === DEFAULT_MODEL_VALUE ? "" : value)}
                tooltipTitle={intl.formatMessage({ id: "chat.toolbar.model.label" })}
                labelVisibilityClassName="inline-flex"
                triggerLabelClassName="block min-w-0 max-w-48 text-left [&>span]:max-w-full [&>span>span]:block [&>span>span]:truncate"
                focusSelectorOnClose={COMPOSER_INPUT_SELECTOR}
              />
              {thoughtOption ? (
                <ThoughtLevelCycleControl
                  composerCollapsePriority={3}
                  labelVisibilityClassName="inline-flex"
                  indicatorClassName="block"
                  option={thoughtOption}
                  onValueChange={(value) => void setEffort(value)}
                  intl={intl}
                  triggerRef={thoughtTriggerRef}
                  restoreFocusSelector={COMPOSER_INPUT_SELECTOR}
                />
              ) : null}
            </span>
            {running ? (
              <ControlHintTooltip title="停止" shortcut="Esc">
                <Button type="button" variant="secondary" size="icon-md" onClick={() => void interrupt()} aria-label="停止">
                  <SquareIcon className="size-4 fill-current" />
                </Button>
              </ControlHintTooltip>
            ) : (
              <ControlHintTooltip title="发送" shortcut="Enter">
                <Button
                  type="submit"
                  size="icon-md"
                  disabled={!canSend || conversation.loading || adding > 0 || submitting}
                  aria-label="发送"
                  className="cursor-pointer gap-1 rounded-lg bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"
                >
                  <ArrowUpIcon className="size-4" />
                </Button>
              </ControlHintTooltip>
            )}
          </div>
        </div>
      </div>
    </form>
    {isDraft ? <DraftContextBar conversation={conversation} /> : null}
    </>
  );
}
