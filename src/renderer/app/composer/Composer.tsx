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
import { AGENT_KINDS, AGENTS, type PermissionModeOption } from "@hcode/shared/agents";
import type { AgentKind, FileInput, ImageInput, SlashCommandOption } from "@hcode/shared/types";
import { CollaborationPanel } from "../collaboration/CollaborationPanel";
import { useActiveCollaboration } from "../collaboration/useCollaborationSession";
import { useUiStore } from "../store/uiStore";
import { WorkModeMenu } from "./WorkModeMenu";
import { WORK_MODES, useWorkMode, submissionForMode } from "./workMode";
import { AgentBadge } from "../AgentBadge";
import { DraftContextBar } from "./DraftContextBar";
import { UsageIndicator } from "./UsageIndicator";
import { QueuedMessages } from "./QueuedMessages";
import { PromptSuggestionHint } from './PromptSuggestionHint';
import { usePromptSuggestion } from './usePromptSuggestion';
import { drafts, fileDrafts, imageDrafts } from "./drafts";
import { draftKey, loadDraft, saveDraft } from "./persist";
import { ImageAttachments } from "../ImageAttachments";
import { FileAttachments } from "../FileAttachments";
import { hcode, isRemote } from "../bridge";
import { useNarrowRemote } from "../remote/useNarrowRemote";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import { getThoughtLevelLabel } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { appendPromptHistoryEntry, navigatePromptHistory } from "@/lib/promptHistory.js";
import { persistPromptHistoryEntries, readPromptHistoryEntries } from "@/lib/promptHistoryStorage.js";
import { modelEfforts, useAppStore, type Conversation, type QueuedMessage } from "../store/appStore";

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
/** Radix 的模型选项值不能为空串，默认模型用占位值代替。 */
const DEFAULT_MODEL_VALUE = "__default__";


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
  if (isRemote && window.matchMedia("(max-width: 767px)").matches) return;
  document.querySelector<HTMLElement>(COMPOSER_INPUT_SELECTOR)?.focus();
}

function fileMentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|[\s，,、(（])@([^\s@]*)$/.exec(before);
  return match ? { start: caret - match[2]!.length - 1, query: match[2]! } : null;
}

export function Composer({
  conversation,
  onSubmitted,
}: {
  conversation: Conversation;
  onSubmitted: () => void;
}) {
  const narrow = useNarrowRemote();
  const send = useAppStore((state) => state.send);
  const sendGroup = useAppStore((state) => state.sendGroup);
  const interrupt = useAppStore((state) => state.interrupt);
  const enqueue = useAppStore((state) => state.enqueue);
  const removeQueued = useAppStore((state) => state.removeQueued);
  const setPermissionMode = useAppStore((state) => state.setPermissionMode);
  const setModel = useAppStore((state) => state.setModel);
  const setEffort = useAppStore((state) => state.setEffort);
  const setCodexSpeed = useAppStore((state) => state.setCodexSpeed);
  const setDraftAgent = useAppStore((state) => state.setDraftAgent);
  const loadModels = useAppStore((state) => state.loadModels);
  const modelError = useAppStore((state) => state.modelErrors[conversation.agent]);
  const modelsLoading = useAppStore((state) => state.modelsLoading[conversation.agent]);
  const agentStatuses = useAppStore((state) => state.agentStatuses);
  const models = useAppStore((state) => state.models[conversation.agent]) ?? AGENTS[conversation.agent].models;
  const agentDelegation = useAppStore((state) => state.settings.agentDelegation);
  const isDraft = !conversation.sessionKey && !conversation.sessionId;
  // 已有对比组的会话固定按普通对话发送（由 sendGroup 分发到组内每个 CLI）
  const selectedMode = useWorkMode(state => state.views[conversation.viewId]?.mode);
  const workMode = conversation.compareId ? "chat" : selectedMode ?? "chat";
  const activeCollaboration = useActiveCollaboration(conversation);
  const setSidePanel = useUiStore(state => state.setSidePanel);
  const persistedKey = draftKey(conversation);
  // 内存里的草稿优先；重启后从 localStorage 恢复
  const [text, setText] = useState(() => drafts.get(conversation.viewId) ?? loadDraft(persistedKey).text);
  const [images, setImages] = useState<ImageInput[]>(() => imageDrafts.get(conversation.viewId) ?? []);
  const [files, setFiles] = useState<FileInput[]>(() => fileDrafts.get(conversation.viewId) ?? loadDraft(persistedKey).files);
  const [adding, setAdding] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [caret, setCaret] = useState(() => text.length);
  const [dismissedMention, setDismissedMention] = useState("");
  const [fileResults, setFileResults] = useState<{ key: string; paths: string[]; loading: boolean }>({ key: "", paths: [], loading: false });
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [slashResults, setSlashResults] = useState<{ key: string; commands: SlashCommandOption[]; loading: boolean }>({ key: "", commands: [], loading: false });
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [dismissedSlash, setDismissedSlash] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { intl } = useZCodeIntl();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // ↑/↓ 历史输入：照 ZCode PromptHistoryPlugin，按项目存 localStorage；index 为 null 表示不在历史浏览态
  const [promptHistory, setPromptHistory] = useState<readonly string[]>(() =>
    readPromptHistoryEntries(conversation.projectPath),
  );
  const historyIndexRef = useRef<number | null>(null);
  const caretToEndRef = useRef(false);
  const running = conversation.runState === "running" || conversation.runState === "awaitingApproval";
  const prediction = usePromptSuggestion(conversation, text, conversation.runState === 'idle' && !conversation.loading && !conversation.compareId && workMode === 'chat' && !activeCollaboration && conversation.queue.length === 0 && !images.length && !files.length && !adding && !submitting);
  const acceptPrediction = () => {
    if (!prediction.suggestion) return;
    const suggestion = prediction.suggestion;
    prediction.dismiss();
    historyIndexRef.current = null;
    caretToEndRef.current = true;
    setText(suggestion); setCaret(suggestion.length);
    textareaRef.current?.focus();
  };
  const activeInTerminal = useAppStore(
    (state) =>
      !conversation.sessionKey &&
      Boolean(
        conversation.sessionId &&
          state.sessions[conversation.projectPath]?.find((item) => item.id === conversation.sessionId)
            ?.activeInTerminal,
      ),
  );
  const mention = fileMentionAt(text, caret);
  const mentionKey = mention ? `${conversation.projectPath}\0${mention.start}\0${mention.query}` : "";
  const showFileResults = Boolean(mention && mentionKey !== dismissedMention);
  const slashMatch = caret === text.length ? /^\/([^\s]*)$/.exec(text) : null;
  const slashContext = `${conversation.agent}\0${conversation.projectPath}\0${conversation.sessionKey ?? ""}\0${conversation.sessionId ?? ""}`;
  const showSlashResults = Boolean(slashMatch && text !== dismissedSlash && !showFileResults);
  const matchingCommands = slashResults.key === slashContext
    ? slashResults.commands.filter((command) => {
        const query = slashMatch?.[1]?.toLowerCase() ?? "";
        return command.name.toLowerCase().includes(query) || command.aliases?.some((alias) => alias.toLowerCase().includes(query));
      })
    : [];

  useEffect(() => {
    if (!showSlashResults) return;
    let cancelled = false;
    setSlashResults((current) => current.key === slashContext ? current : { key: slashContext, commands: [], loading: true });
    void hcode.invoke("agent:commands", conversation.agent, conversation.projectPath, conversation.sessionKey, conversation.sessionId)
      .then((commands) => {
        if (!cancelled) setSlashResults({ key: slashContext, commands, loading: false });
      })
      .catch(() => {
        if (!cancelled) setSlashResults({ key: slashContext, commands: [], loading: false });
      });
    return () => { cancelled = true; };
  }, [showSlashResults, slashContext]);

  useEffect(() => {
    if (!conversation.sessionKey) return;
    return hcode.on("chat:commands", (event) => {
      if (event.sessionKey === conversation.sessionKey) {
        setSlashResults({ key: slashContext, commands: event.commands, loading: false });
      }
    });
  }, [conversation.sessionKey, slashContext]);

  const insertSlashCommand = (command: SlashCommandOption) => {
    const next = `/${command.name}${command.argumentHint ? " " : ""}`;
    setText(next);
    setCaret(next.length);
    setDismissedSlash(next);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.length, next.length);
    });
  };

  useEffect(() => { setActiveSlashIndex(0); }, [slashMatch?.[1], slashContext]);

  useEffect(() => {
    if (!showFileResults || !mention) return;
    let cancelled = false;
    const key = mentionKey;
    const query = mention.query;
    const timer = window.setTimeout(() => {
      setFileResults({ key, paths: [], loading: true });
      void hcode.invoke("fs:listProjectFiles", conversation.projectPath, query).then((paths) => {
        if (!cancelled) {
          setFileResults({ key, paths, loading: false });
          setActiveFileIndex(0);
        }
      }).catch(() => {
        if (!cancelled) setFileResults({ key, paths: [], loading: false });
      });
    }, 100);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [conversation.projectPath, mentionKey, showFileResults]);

  const insertFileMention = (path: string) => {
    if (!mention) return;
    const end = caret;
    const suffix = text.slice(end);
    const token = /[\s@"\\，,、。!?;:]|\.$/.test(path) ? `@${JSON.stringify(path)}` : `@${path}`;
    const addition = `${token}${!/^\s/.test(suffix) ? " " : ""}`;
    const next = text.slice(0, mention.start) + addition + suffix;
    const nextCaret = mention.start + addition.length;
    setText(next);
    setCaret(nextCaret);
    setDismissedMention("");
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  useEffect(() => {
    drafts.set(conversation.viewId, text);
  }, [conversation.viewId, text]);

  useEffect(() => {
    imageDrafts.set(conversation.viewId, images);
  }, [conversation.viewId, images]);

  useEffect(() => {
    fileDrafts.set(conversation.viewId, files);
  }, [conversation.viewId, files]);

  // 存储 key 变化（草稿发送后有了会话 id、或切换项目）时清掉旧 key
  const previousKey = useRef(persistedKey);
  useEffect(() => {
    if (previousKey.current && previousKey.current !== persistedKey) saveDraft(previousKey.current, "", []);
    previousKey.current = persistedKey;
    if (persistedKey) saveDraft(persistedKey, text, files);
  }, [persistedKey, text, files]);

  // 编辑重发：消息被放回输入框
  const prefill = useAppStore((state) => state.composerPrefill);
  useEffect(() => {
    if (!prefill || prefill.viewId !== conversation.viewId) return;
    prediction.dismiss();
    setText(prefill.text);
    setImages(prefill.images);
    setFiles(prefill.files);
    setCaret(prefill.text.length);
    useAppStore.setState({ composerPrefill: null });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [prefill, conversation.viewId]);

  /** 本地文件只传路径；剪贴板文件没有路径时暂存到 HCode 数据目录。 */
  const addFiles = async (selected: readonly File[]) => {
    if (selected.length === 0) return;
    prediction.dismiss();
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
    if (!narrow) textareaRef.current?.focus();
  }, [conversation.viewId, narrow]);

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
  }, [text, prediction.suggestion]);

  const canSend = Boolean(text.trim() || images.length > 0 || files.length > 0);

  const submission = submissionForMode(workMode, { text, imageCount: images.length, fileCount: files.length, busy: running || conversation.queue.length > 0, activeCollaboration: Boolean(activeCollaboration) });
  const attachmentBlocked = submissionForMode("collaboration", { text: "goal", imageCount: images.length, fileCount: files.length, busy: false, activeCollaboration: false }).reason;

  const rememberPrompt = (value: string) => {
    const projectPath = conversation.projectPath;
    const nextHistory = appendPromptHistoryEntry(readPromptHistoryEntries(projectPath), value);
    persistPromptHistoryEntries(projectPath, nextHistory);
    setPromptHistory(nextHistory);
    historyIndexRef.current = null;
  };

  const submit = () => {
    if (!canSend || conversation.loading || adding || submitting || submission.reason) return;
    if (submission.action === "plan") {
      setSidePanel({ type: "collaboration", viewId: conversation.viewId, intent: "plan" });
      return;
    }
    if (running && !conversation.compareId) {
      // 运行中先排队，本轮结束后自动发送
      enqueue(text, images, files);
      rememberPrompt(text);
      setText("");
      setImages([]);
      setFiles([]);
      return;
    }
    setSubmitting(true);
    const sending = conversation.compareId ? sendGroup(text, images, files) : send(text, images, files);
    void sending.then((sent) => {
      if (!sent) return;
      rememberPrompt(text);
      setText((current) => current === text ? "" : current);
      setImages((current) => current === images ? [] : current);
      setFiles((current) => current === files ? [] : current);
      onSubmitted();
    }).finally(() => setSubmitting(false));
  };

  /** 把排队消息退回输入框编辑；输入框有内容时不覆盖。 */
  const editQueued = (item: QueuedMessage) => {
    if (canSend) {
      toast("请先发送或清空当前草稿，再编辑队列消息。", { variant: "warning" });
      return;
    }
    removeQueued(item.id);
    caretToEndRef.current = true;
    setText(item.text);
    setImages(item.images);
    setFiles(item.files);
    textareaRef.current?.focus();
  };

  const agent = AGENTS[conversation.agent];
  const modeInfo =
    agent.permissionModes.find((item) => item.mode === conversation.permissionMode) ?? agent.permissionModes[0]!;
  const modelLabel = models.find((item) => item.value === conversation.model)?.label ?? conversation.model;
  const modelGroups = useMemo<ModelSelectGroup[]>(
    () => (isDraft ? AGENT_KINDS : [conversation.agent]).map((kind) => ({
      key: kind,
      label: AGENTS[kind].name,
      labelBadge: "CLI",
      icon: <AgentBadge agent={kind} className="size-4.5" />,
      disabled: agentStatuses?.some((status) => status.kind === kind && !status.found),
      // CLI 可能返回相同模型值（包括默认值），只展示当前 CLI 的模型目录。
      items: kind === conversation.agent ? models.map((item) => ({
        key: item.value || DEFAULT_MODEL_VALUE,
        value: item.value || DEFAULT_MODEL_VALUE,
        name: item.label,
      })) : [],
    })),
    [conversation.agent, models, isDraft, agentStatuses],
  );
  const efforts = modelEfforts(models, conversation.model);
  const effortOption = { id: "thought_level", name: "思考强度", category: "thought_level", type: "select" as const, currentValue: conversation.effort };
  // CLI 默认是独立选择，不把未设置的值误显示成最低档。
  const effortLevels = efforts.length > 0 ? [
    ...(efforts.length > 1 ? [{ value: "", label: "CLI 默认" }] : []),
    ...efforts.filter(Boolean).map((value) => ({
      value,
      label: getThoughtLevelLabel(intl, undefined, effortOption, { value, name: value }),
    })),
  ] : [];
  const effortValue = effortLevels.length === 1
    ? effortLevels[0]!.value
    : efforts.includes(conversation.effort) ? conversation.effort : "";

  useEffect(() => {
    if (effortLevels.length < 2) return;
    const cycleEffort = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== "t") return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || (!textareaRef.current?.closest("form")?.contains(target) && !target.closest("[data-composer-model-menu]"))) return;
      event.preventDefault();
      if (modelsLoading) return;
      const index = effortLevels.findIndex((level) => level.value === effortValue);
      void setEffort(effortLevels[(index + 1) % effortLevels.length]!.value);
    };
    window.addEventListener("keydown", cycleEffort, true);
    return () => window.removeEventListener("keydown", cycleEffort, true);
  }, [effortLevels, effortValue, modelsLoading, setEffort]);

  return (
    <>
    {!conversation.compareId && !isRemote ? <CollaborationPanel conversation={conversation} currentInput={text} workMode={workMode} attachmentBlocked={attachmentBlocked} onStarted={input => { setText(current => current === input ? "" : current); onSubmitted(); }} /> : null}
    {submission.reason ? <p role="status" className="mb-2 text-ui-sm text-foreground-subtle">{submission.reason}</p> : workMode !== "chat" ? <p className="mb-2 text-ui-sm text-foreground-subtle">{WORK_MODES[workMode].description}</p> : null}
    {activeInTerminal ? (
      <div className="mb-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-ui-sm text-foreground-subtle">
        这个会话正在某个终端的 claude 中运行。在这里继续发送会与终端同时写入同一会话，建议先在终端里退出。
      </div>
    ) : null}
    <QueuedMessages conversation={conversation} onEdit={editQueued} />
    {/* 手机上的新会话照 ZCode：项目 / 分支选择放在输入框上方，与输入框合成一张卡 */}
    <div className={cn(narrow && isDraft && "rounded-2xl bg-surface shadow-xl/5")}>
    {narrow && isDraft ? <DraftContextBar conversation={conversation} className="p-1.5" /> : null}
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
      className="composer-input relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-input-border bg-input p-3 transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused focus-within:bg-input-focused"
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
        aria-label={`给 ${agent.name} 发消息`}
        onChange={(event) => {
          prediction.dismiss();
          const index = historyIndexRef.current;
          // 手动改过回填的历史后退出浏览态，上下键恢复为移动光标
          if (index !== null && event.target.value !== promptHistory[index]) historyIndexRef.current = null;
          setText(event.target.value);
          setCaret(event.target.selectionStart);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (files.length === 0) return;
          event.preventDefault();
          void addFiles(files);
        }}
        onKeyDown={(event) => {
          if (showSlashResults && !event.nativeEvent.isComposing && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
            if (event.key === "Escape") {
              event.preventDefault();
              setDismissedSlash(text);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (matchingCommands.length) setActiveSlashIndex((index) =>
                (index + (event.key === "ArrowDown" ? 1 : matchingCommands.length - 1)) % matchingCommands.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              if (matchingCommands.length || slashResults.key !== slashContext || slashResults.loading || text === "/") {
                event.preventDefault();
                if (matchingCommands.length) insertSlashCommand(matchingCommands[Math.min(activeSlashIndex, matchingCommands.length - 1)]!);
                return;
              }
            }
          }
          if (showFileResults && !event.nativeEvent.isComposing) {
            const paths = fileResults.key === mentionKey ? fileResults.paths : [];
            if (event.key === "Escape") {
              event.preventDefault();
              setDismissedMention(mentionKey);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (paths.length) setActiveFileIndex((index) => (index + (event.key === "ArrowDown" ? 1 : paths.length - 1)) % paths.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              if (paths.length || fileResults.key !== mentionKey || fileResults.loading) {
                event.preventDefault();
                if (paths.length) insertFileMention(paths[Math.min(activeFileIndex, paths.length - 1)]!);
                return;
              }
            }
          }
          if (prediction.suggestion && !event.nativeEvent.isComposing && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'Tab' || event.key === 'Escape')) {
            event.preventDefault();
            if (event.key === 'Tab') acceptPrediction();
            else prediction.dismiss();
            return;
          }
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
            prediction.dismiss();
            event.preventDefault();
            historyIndexRef.current = result.nextIndex;
            if (result.nextValue !== text) {
              caretToEndRef.current = true;
              setText(result.nextValue);
            }
          }
        }}
        placeholder={prediction.suggestion ?? (narrow ? (running ? "输入消息以排队发送…" : `给 ${agent.name} 发消息…`) : conversation.compareId ? "同时发给对比组里的每个 CLI，Enter 发送，Shift+Enter 换行" : running ? `${agent.name} 正在工作…继续输入可排队发送（Esc 停止）` : `给 ${agent.name} 发消息，Enter 发送，Shift+Enter 换行`)}
        className="max-h-40 min-h-10 w-full resize-none overflow-y-auto bg-transparent text-ui-base leading-5 text-foreground outline-none placeholder:text-foreground-subtlest"
      />
      {prediction.suggestion ? <PromptSuggestionHint onAccept={acceptPrediction} onDismiss={prediction.dismiss} /> : null}
      {showSlashResults ? (
        <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg" role="listbox" aria-label="斜杠命令">
          {slashResults.key !== slashContext || slashResults.loading ? (
            <div className="px-2 py-2 text-ui-sm text-foreground-subtle">读取命令中…</div>
          ) : matchingCommands.length ? matchingCommands.map((command, index) => (
            <button
              key={`${command.name}-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeSlashIndex}
              className={cn("flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left text-ui-sm hover:bg-surface-hover", index === activeSlashIndex && "bg-surface-hover")}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveSlashIndex(index)}
              onClick={() => insertSlashCommand(command)}
            >
              <span className="shrink-0 font-medium">/{command.name}</span>
              {command.kind === "skill" ? <span className="shrink-0 text-foreground-subtlest">技能</span> : null}
              {command.argumentHint ? <span className="shrink-0 text-foreground-subtle">{command.argumentHint}</span> : null}
              <span className="min-w-0 truncate text-foreground-subtle">{command.description}</span>
            </button>
          )) : (
            <div className="px-2 py-2 text-ui-sm text-foreground-subtle">没有匹配的命令</div>
          )}
        </div>
      ) : null}
      {showFileResults ? (
        <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg" role="listbox" aria-label="项目文件">
          {fileResults.key !== mentionKey || fileResults.loading ? (
            <div className="px-2 py-2 text-ui-sm text-foreground-subtle">搜索项目文件中…</div>
          ) : fileResults.paths.length ? fileResults.paths.map((path, index) => (
            <button
              key={path}
              type="button"
              role="option"
              aria-selected={index === activeFileIndex}
              className={cn("flex w-full min-w-0 items-center rounded-md px-2 py-1.5 text-left text-ui-sm hover:bg-surface-hover", index === activeFileIndex && "bg-surface-hover")}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveFileIndex(index)}
              onClick={() => insertFileMention(path)}
            >
              <FileDisplayInline path={path} options={{ className: "inline-flex min-w-0 items-center gap-1", fileNameClassName: "truncate" }} />
              <span className="ml-2 min-w-0 truncate text-foreground-subtle">{path}</span>
            </button>
          )) : (
            <div className="px-2 py-2 text-ui-sm text-foreground-subtle">没有匹配的项目文件</div>
          )}
        </div>
      ) : null}
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
      {/* 工具条照 ZCode ChatPromptEditor：左侧 + / 权限模式，右侧模型与思考强度合并入口 / 发送 */}
      <div className="composer-toolbar group/toolbar flex flex-wrap items-end gap-3">
        <div className="composer-toolbar-primary flex min-w-0 flex-wrap items-center">
          <div className="composer-toolbar-controls flex min-w-0 flex-wrap items-center gap-1">
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
            {!conversation.compareId && !isRemote ? <WorkModeMenu mode={workMode} onMode={mode => useWorkMode.getState().select(conversation.viewId, mode)} onClose={restoreInputFocus} /> : null}
            {agentDelegation && !conversation.compareId && (conversation.agent === "claude" || conversation.agent === "codex") ? <span className="text-ui-sm text-foreground-subtle" title="普通对话可调用其他 AI（设置 → AI 委派）">委派已开启</span> : null}
            <DropdownMenu>
              <ControlHintTooltip title="权限模式">
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`权限模式：${modeInfo.label}`}
                    className={cn(
                      "h-7 gap-1 rounded-lg px-2 text-ui-base",
                      narrow && "w-7 px-0",
                      modeInfo.dangerous && "text-warning hover:text-warning",
                    )}
                  >
                    {modeIcon(modeInfo)}
                    {/* 手机上照 ZCode 只留图标，给模型与发送按钮腾出同一行的空间 */}
                    {narrow ? null : modeInfo.label}
                    {narrow ? null : <ChevronDownIcon className="size-3.5" />}
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
        <div className="composer-toolbar-secondary ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
            <span className="flex min-w-0 flex-wrap items-center justify-end gap-1 empty:hidden">
              <UsageIndicator usage={conversation.usage} />
              <ModelConfigSelect
                composerOptions={{
                  selectedGroupKey: conversation.agent,
                  providerLabel: "使用的 CLI",
                  modelsLabel: "模型",
                  effortLabel: "思考强度",
                  effortShortcutLabel: "⌃T",
                  selectModelLabel: "选择模型",
                  levels: effortLevels,
                  value: effortValue,
                  onValueChange: (value) => void setEffort(value),
                  speed: conversation.agent === "codex" ? {
                    value: conversation.codexSpeed,
                    onValueChange: (value) => void setCodexSpeed(value),
                  } : undefined,
                  onGroupChange: isDraft ? (group) => {
                    if (AGENT_KINDS.includes(group.key as AgentKind)) setDraftAgent(group.key as AgentKind);
                  } : undefined,
                  loading: modelsLoading,
                  error: modelError,
                  onRetry: () => void loadModels(conversation.agent, true),
                }}
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
                triggerLabelClassName={cn("block min-w-0 text-left [&>span]:max-w-full [&>span>span]:block [&>span>span]:truncate", narrow ? "max-w-32" : "max-w-48")}
                focusSelectorOnClose={COMPOSER_INPUT_SELECTOR}
              />
            </span>
            {running ? (
              <ControlHintTooltip title="停止" shortcut="Esc">
                <Button type="button" variant="secondary" size="icon-md" onClick={() => void interrupt()} aria-label="停止">
                  <SquareIcon className="size-4 fill-current" />
                </Button>
              </ControlHintTooltip>
            ) : (
              <ControlHintTooltip title={WORK_MODES[workMode].action} shortcut="Enter">
                <Button
                  type="submit"
                  size={submission.action === "plan" ? "sm" : "icon-md"}
                  disabled={!canSend || conversation.loading || adding > 0 || submitting || Boolean(submission.reason)}
                  aria-label={WORK_MODES[workMode].action}
                  className="cursor-pointer gap-1 rounded-lg bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"
                >
                  {submission.action === "plan" ? WORK_MODES[workMode].action : <ArrowUpIcon className="size-4" />}
                </Button>
              </ControlHintTooltip>
            )}
          </div>
        </div>
      </div>
    </form>
    </div>
    {isDraft && !narrow ? <DraftContextBar conversation={conversation} /> : null}
    </>
  );
}
