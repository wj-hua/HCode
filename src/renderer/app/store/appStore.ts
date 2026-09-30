// HCode 渲染进程主状态：项目、会话列表、打开的对话、审批请求。
import { arrayMove } from "@dnd-kit/sortable";
import { create } from "zustand";
import type {
  AgentKind,
  AgentStatus,
  ModelOption,
  ChatRunState,
  ChatUsage,
  ConversationRow,
  FileInput,
  ForkMode,
  GitTurnDiff,
  ImageInput,
  NotificationEvent,
  PermissionDecision,
  PermissionMode,
  PermissionRequestEvent,
  Project,
  SessionSummary,
  Settings,
  SettingsPatch,
} from "@hcode/shared/types";
import { DEFAULT_SETTINGS } from "@hcode/shared/types";
import { AGENTS } from "@hcode/shared/agents";
import { toast } from "@/components/ui/toast.js";
import { hcode } from "../bridge";
import { playNotificationSound } from "../notificationSound";
import { applyRowOps } from "../rows";
import { drafts, fileDrafts, imageDrafts } from "../composer/drafts";
import { discardPersisted, loadQueue, saveQueue } from "../composer/persist";
import { useUiStore } from "./uiStore";

/** 运行中输入、等本轮结束后自动发送的消息。 */
export interface QueuedMessage {
  id: string;
  text: string;
  images: ImageInput[];
  files: FileInput[];
}

export interface Conversation {
  viewId: string;
  agent: AgentKind;
  projectPath: string;
  /** Claude 会话 id：历史会话一开始就有，新会话在首轮 init 后获得。 */
  sessionId?: string;
  /** 主进程中活动会话的 key（首次发送时生成）。 */
  sessionKey?: string;
  title?: string;
  rows: ConversationRow[];
  loading: boolean;
  loadError?: string;
  runState: ChatRunState;
  /** 当前轮开始运行的时间；空闲或出错时为 undefined。 */
  runStartedAt?: number;
  /** 后台完成 / 出错后还没查看：会话在侧边栏显示未读点，看过后清除。 */
  unread?: "done" | "error";
  error?: string;
  permissionMode: PermissionMode;
  /** 用户选择的模型（空串 = CLI 默认）。 */
  model: string;
  /** Claude 实际使用的模型 id（来自 init）。 */
  activeModel?: string;
  usage?: ChatUsage;
  /** undefined = 尚无本轮记录；null = 正在收集本轮改动。 */
  turnDiff?: GitTurnDiff | null;
  /** 本轮发送的用户消息，用于生成提交说明。 */
  turnPrompt?: string;
  /** 用户选择的思考强度（空串 = CLI 默认）；当前模型不支持时不发送。 */
  effort: string;
  queue: QueuedMessage[];
  /** 队列暂停原因：用户停止或本轮出错后不再自动发送，等用户点「继续」。 */
  queuePaused?: "stopped" | "error";
  /** 多 CLI 对比：同一组会话共用同一个 id，界面并排显示。 */
  compareId?: string;
}

interface AppState {
  ready: boolean;
  settings: Settings;
  agentStatuses: AgentStatus[] | null;
  models: Partial<Record<AgentKind, ModelOption[]>>;
  projects: Project[];
  sessions: Record<string, SessionSummary[]>;
  expanded: Record<string, boolean>;
  search: string;
  conversations: Record<string, Conversation>;
  activeViewId: string | null;
  permissions: Record<string, PermissionRequestEvent>;
  sidebarCollapsed: boolean;
  settingsOpen: boolean;
  fullscreen: boolean;
  /** 编辑重发：待写入某个会话输入框的内容，输入框挂载后取走。 */
  composerPrefill: { viewId: string; text: string; images: ImageInput[]; files: FileInput[] } | null;

  init(): Promise<void>;
  refreshProjects(): Promise<void>;
  loadSessions(projectPath: string): Promise<void>;
  toggleProject(projectPath: string, expanded?: boolean): void;
  setSearch(search: string): void;
  openSession(summary: SessionSummary): Promise<void>;
  newChat(projectPath: string, agent?: AgentKind): void;
  /** 草稿会话（还没发送过）切换使用的 CLI。 */
  setDraftAgent(agent: AgentKind): void;
  /** 草稿会话切换工作目录。 */
  setDraftProject(projectPath: string): void;
  loadModels(agent: AgentKind): Promise<void>;
  send(text: string, images?: ImageInput[], files?: FileInput[]): Promise<boolean>;
  /** 草稿会话与 agents 中的其他 CLI 组成对比组，同一消息同时发给每个 CLI。 */
  startCompare(agents: AgentKind[], text: string, images: ImageInput[], files: FileInput[]): Promise<boolean>;
  /** 把消息发给当前会话所在对比组的每个 CLI；正在运行的加入其队列。 */
  sendGroup(text: string, images: ImageInput[], files: FileInput[]): Promise<boolean>;
  /** 运行中把消息加入当前会话的队列。 */
  enqueue(text: string, images: ImageInput[], files: FileInput[]): void;
  removeQueued(id: string): void;
  /** 取消暂停，空闲时立即发送队首。 */
  resumeQueue(): void;
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  /** 思考强度随下一次发送生效，并记为该 CLI 新会话的默认值。 */
  setEffort(effort: string): Promise<void>;
  respondPermission(interactionId: string, decision: PermissionDecision): Promise<void>;
  addProject(): Promise<void>;
  setProjectPinned(path: string, pinned: boolean): Promise<void>;
  removeProject(path: string): Promise<void>;
  /** 拖动排序：把 activePath 移到 overPath 所在位置。 */
  reorderProjects(activePath: string, overPath: string): Promise<void>;
  renameSession(summary: SessionSummary, title: string): Promise<void>;
  /** 删除会话（Codex 为归档），并关闭已打开的对话视图。 */
  deleteSession(summary: SessionSummary): Promise<void>;
  /** 从当前会话的某条用户消息分叉出新会话并打开；回退时把这条消息放回新会话的输入框。 */
  forkFromMessage(rowId: number, mode: ForkMode): Promise<void>;
  /** 把某条用户消息原样再发一次（同一会话，作为新一轮）。 */
  retryMessage(rowId: number): Promise<void>;
  /** 把某条用户消息放回当前会话的输入框，修改后作为新消息发送。 */
  editMessage(rowId: number): void;
  updateSettings(patch: SettingsPatch): Promise<void>;
  setSidebarCollapsed(collapsed: boolean): void;
  setSettingsOpen(open: boolean): void;
  /** 关闭当前视图；会话记录仍保留在项目列表中。 */
  closeActiveView(): Promise<void>;
  activateView(viewId: string): void;
  /** 窗口聚焦时，把当前查看的会话（含对比组）标为已读。 */
  markViewed(): void;
}

/** 模型支持的思考强度档位；模型列表还没拉到或模型不支持时为空。 */
export function modelEfforts(models: readonly ModelOption[], model: string): string[] {
  return models.find((item) => item.value === model)?.efforts ?? [];
}

const NOTIFY_STATUS: Record<NotificationEvent, string> = {
  start: "开始执行",
  done: "任务已完成",
  error: "运行出错",
  approval: "等待审批",
};

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // ipcRenderer.invoke 的错误带有 "Error invoking remote method 'x': Error: " 前缀
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** 最后一条助手回复的首行，作为通知正文。 */
function lastAssistantText(rows: readonly ConversationRow[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind !== "assistantText") continue;
    const line = row.text.split("\n").map((item) => item.trim()).find(Boolean);
    if (line) return line;
  }
  return "";
}

/** 会话标题：已有标题优先，否则取首条用户消息的首行。 */
export function conversationTitle(conv: Conversation): string {
  const first = conv.rows.find((row) => row.kind === "userInput");
  const line = first?.kind === "userInput" ? first.text.split("\n").map((item) => item.trim()).find(Boolean) : undefined;
  return conv.title ?? line ?? "新会话";
}

/** 已打开会话的占位摘要：标题取首条用户消息。 */
function liveSummary(conv: Conversation & { sessionId: string }): SessionSummary {
  const title = conversationTitle(conv);
  const now = Date.now();
  return {
    id: conv.sessionId,
    agent: conv.agent,
    projectPath: conv.projectPath,
    title: title.length > 80 ? `${title.slice(0, 80)}…` : title,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * CLI 的会话索引可能滞后（Codex 新线程要等本轮结束才刷新列表），
 * 把已打开但列表里还没有的会话补进去，否则切到别的会话后侧栏里就找不到它了。
 */
function withLiveSessions(
  list: SessionSummary[],
  projectPath: string,
  conversations: Record<string, Conversation>,
): SessionSummary[] {
  const ids = new Set(list.map((item) => item.id));
  const live = Object.values(conversations)
    .filter((conv): conv is Conversation & { sessionId: string } =>
      conv.projectPath === projectPath && Boolean(conv.sessionId) && !ids.has(conv.sessionId!))
    .map(liveSummary);
  return live.length ? [...live, ...list].sort((a, b) => b.updatedAt - a.updatedAt) : list;
}

/** 用户消息的附件转回输入框格式：内联图片 → ImageInput，本地路径 → FileInput。 */
function rowAttachments(row: Extract<ConversationRow, { kind: "userInput" }>): { images: ImageInput[]; files: FileInput[] } {
  const attachments = row.attachments ?? [];
  const images = attachments.flatMap((item) => {
    const match = /^data:([^;,]+);base64,(.*)$/.exec(item.ref);
    return match ? [{ mimeType: match[1]!, data: match[2]!, name: item.fileName }] : [];
  });
  const files = attachments
    .filter((item) => item.ref.startsWith("/"))
    .map((item) => ({ path: item.ref, name: item.fileName, mimeType: item.mime, size: item.bytes }));
  return { images, files };
}

let draftSeq = 0;

export const useAppStore = create<AppState>((set, get) => {
  const patchConversation = (viewId: string, patch: Partial<Conversation>) =>
    set((state) => {
      const current = state.conversations[viewId];
      if (!current) return state;
      return { conversations: { ...state.conversations, [viewId]: { ...current, ...patch } } };
    });

  const findBySessionKey = (sessionKey: string): Conversation | undefined =>
    Object.values(get().conversations).find((conv) => conv.sessionKey === sessionKey);

  const activeConversation = (): Conversation | undefined => {
    const { activeViewId, conversations } = get();
    return activeViewId ? conversations[activeViewId] : undefined;
  };

  const draftConversation = (viewId: string, projectPath: string, agent: AgentKind): Conversation => {
    const { settings } = get();
    return {
      viewId,
      agent,
      projectPath,
      rows: [],
      loading: false,
      runState: "idle",
      permissionMode: settings.defaultPermissionModes[agent],
      model: settings.defaultModels[agent],
      effort: settings.defaultEfforts[agent],
      queue: [],
    };
  };

  /** 当前会话所在的对比组（没有对比组时只有它自己）。 */
  const groupOf = (conv: Conversation): Conversation[] =>
    conv.compareId
      ? Object.values(get().conversations).filter((item) => item.compareId === conv.compareId)
      : [conv];

  const enqueueConversation = (viewId: string, text: string, images: ImageInput[], files: FileInput[]) => {
    const conv = get().conversations[viewId];
    if (!conv || (!text.trim() && images.length === 0 && files.length === 0)) return;
    patchConversation(viewId, { queue: [...conv.queue, { id: crypto.randomUUID(), text, images, files }] });
  };

  /** 开始执行时在前台只播放提示音；后台发系统通知，点击后回到该会话。 */
  const notify = async (conv: Conversation, event: NotificationEvent, body: string) => {
    const { settings } = get();
    if (!settings.notifyOnFinish) return;
    if (document.hasFocus()) {
      if (event === "start") void playNotificationSound(settings, event);
      return;
    }
    const summary = conv.sessionId
      ? get().sessions[conv.projectPath]?.find((item) => item.id === conv.sessionId)
      : undefined;
    const title = summary?.title ?? conv.title ?? conv.projectPath.split("/").filter(Boolean).at(-1) ?? "HCode";
    const silent = await playNotificationSound(settings, event);
    const notification = new Notification(`${AGENTS[conv.agent].name} ${NOTIFY_STATUS[event]}`, {
      body: `${title}\n${body}`.slice(0, 200),
      silent,
    });
    notification.onclick = () => {
      if (get().conversations[conv.viewId]) set({ activeViewId: conv.viewId });
      void hcode.invoke("app:focusWindow");
    };
  };

  const sendConversation = async (
    viewId: string,
    text: string,
    images: ImageInput[],
    files: FileInput[],
  ): Promise<boolean> => {
    const conv = get().conversations[viewId];
    if (!conv || (!text.trim() && images.length === 0 && files.length === 0)) return false;
    const sessionKey = conv.sessionKey ?? crypto.randomUUID();
    const resumeSessionId = conv.sessionKey ? undefined : conv.sessionId;
    const models = get().models[conv.agent] ?? AGENTS[conv.agent].models;
    const effort = modelEfforts(models, conv.model).includes(conv.effort) ? conv.effort : "";
    patchConversation(conv.viewId, {
      sessionKey,
      runState: "running",
      turnPrompt: text,
      runStartedAt: conv.runStartedAt ?? Date.now(),
      error: undefined,
      usage: conv.usage ? {
        contextUsedTokens: conv.usage.contextUsedTokens,
        contextWindowTokens: conv.usage.contextWindowTokens,
        contextUsedPercent: conv.usage.contextUsedPercent,
      } : undefined,
      // 队列已清空时，上次停止 / 出错留下的暂停状态没有意义
      ...(conv.queue.length === 0 ? { queuePaused: undefined } : {}),
    });
    try {
      await hcode.invoke("chat:send", {
        agent: conv.agent,
        sessionKey,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        projectPath: conv.projectPath,
        text,
        ...(images.length ? { images } : {}),
        ...(files.length ? { files } : {}),
        permissionMode: conv.permissionMode,
        ...(conv.model ? { model: conv.model } : {}),
        ...(effort ? { effort } : {}),
      });
      void notify(conv, "start", "任务正在执行");
      return true;
    } catch (error) {
      const message = errorMessage(error);
      patchConversation(conv.viewId, {
        runState: "error",
        error: message,
        // 主进程没建起会话时丢掉 key，下次发送重新创建
        ...(conv.sessionKey ? {} : { sessionKey: undefined }),
      });
      toast(message, { variant: "warning" });
      return false;
    }
  };

  /** 会话空闲且队列未暂停时发送队首；发送失败则放回队首并暂停。 */
  const drainQueue = (viewId: string) => {
    const conv = get().conversations[viewId];
    const next = conv?.queue[0];
    if (!conv || !next || conv.queuePaused || conv.runState !== "idle") return;
    patchConversation(viewId, { queue: conv.queue.slice(1) });
    void sendConversation(viewId, next.text, next.images, next.files).then((sent) => {
      const current = get().conversations[viewId];
      if (!sent && current) patchConversation(viewId, { queue: [next, ...current.queue], queuePaused: "error" });
    });
  };

  const subscribeEvents = () => {
    hcode.on("chat:rows", ({ sessionKey, ops }) => {
      const conv = findBySessionKey(sessionKey);
      if (!conv) return;
      patchConversation(conv.viewId, { rows: applyRowOps(conv.rows, ops) });
    });
    hcode.on("chat:state", (event) => {
      const conv = findBySessionKey(event.sessionKey);
      if (!conv) return;
      const wasBusy = conv.runState === "running" || conv.runState === "awaitingApproval";
      const willContinue = conv.queue.length > 0 && !conv.queuePaused;
      const finished = wasBusy && (event.state === "error" || (event.state === "idle" && !willContinue));
      // 正在查看（窗口聚焦且是当前视图或同一对比组）时不算未读
      const active = get().activeViewId ? get().conversations[get().activeViewId!] : undefined;
      const viewed = document.hasFocus() && !!active && (active.viewId === conv.viewId || (!!conv.compareId && active.compareId === conv.compareId));
      if (wasBusy && event.state === "error") {
        void notify(conv, "error", event.error ?? "未知错误");
      } else if (wasBusy && event.state === "idle" && !willContinue) {
        void notify(conv, "done", lastAssistantText(conv.rows));
      }
      patchConversation(conv.viewId, {
        runState: event.state,
        runStartedAt: event.state === "running" || event.state === "awaitingApproval" ? conv.runStartedAt ?? Date.now() : undefined,
        error: event.error,
        permissionMode: event.permissionMode,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.model ? { activeModel: event.model } : {}),
        ...(event.usage ? { usage: event.usage } : {}),
        ...(event.state === "error" ? { queuePaused: "error" as const } : {}),
        ...(finished && !viewed ? { unread: event.state === "error" ? ("error" as const) : ("done" as const) } : {}),
        ...(event.state === "running" ? { unread: undefined } : {}),
      });
      // 新会话拿到 id 时立即出现在侧栏，不等 CLI 写索引
      if (event.sessionId && !conv.sessionId) {
        set((state) => {
          const list = state.sessions[conv.projectPath];
          if (!list) return state;
          return { sessions: { ...state.sessions, [conv.projectPath]: withLiveSessions(list, conv.projectPath, state.conversations) } };
        });
      }
      if (wasBusy && event.state === "idle") drainQueue(conv.viewId);
    });
    hcode.on("git:turnDiff", ({ sessionKey, diff }) => {
      const conv = findBySessionKey(sessionKey);
      if (conv) patchConversation(conv.viewId, { turnDiff: diff });
    });
    hcode.on("permission:requested", (event) => {
      const conv = findBySessionKey(event.sessionKey);
      if (conv) void notify(conv, "approval", event.title ?? event.toolName);
      set((state) => ({ permissions: { ...state.permissions, [event.interactionId]: event } }));
    });
    hcode.on("permission:resolved", ({ interactionId }) => {
      set((state) => {
        const { [interactionId]: _removed, ...rest } = state.permissions;
        return { permissions: rest };
      });
    });
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    hcode.on("sessions:indexChanged", () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void get().refreshProjects();
        for (const [path, expanded] of Object.entries(get().expanded)) {
          if (expanded) void get().loadSessions(path);
        }
      }, 200);
    });
    hcode.on("window:fullscreen", ({ fullscreen }) => set({ fullscreen }));
  };

  return {
    ready: false,
    settings: DEFAULT_SETTINGS,
    agentStatuses: null,
    models: {},
    projects: [],
    sessions: {},
    expanded: {},
    search: "",
    conversations: {},
    activeViewId: null,
    permissions: {},
    sidebarCollapsed: false,
    settingsOpen: false,
    fullscreen: false,
    composerPrefill: null,

    async init() {
      subscribeEvents();
      const settings = await hcode.invoke("settings:get");
      useUiStore.getState().setTheme(settings.theme);
      set({ settings });
      await get().refreshProjects();
      // 默认展开最近活跃的项目
      const first = get().projects[0];
      if (first) get().toggleProject(first.path, true);
      set({ ready: true });
      set({ agentStatuses: await hcode.invoke("agent:status") });
    },

    async refreshProjects() {
      try {
        set({ projects: await hcode.invoke("projects:list") });
      } catch (error) {
        toast(`读取项目失败：${errorMessage(error)}`, { variant: "warning" });
      }
    },

    async loadSessions(projectPath) {
      const list = await hcode.invoke("sessions:list", projectPath);
      set((state) => ({
        sessions: { ...state.sessions, [projectPath]: withLiveSessions(list, projectPath, state.conversations) },
      }));
    },

    toggleProject(projectPath, expanded) {
      const next = expanded ?? !get().expanded[projectPath];
      set((state) => ({ expanded: { ...state.expanded, [projectPath]: next } }));
      if (next) void get().loadSessions(projectPath);
    },

    setSearch(search) {
      set({ search });
    },

    async openSession(summary) {
      const existing = Object.values(get().conversations).find(
        (conv) => conv.sessionId === summary.id,
      );
      if (existing) {
        set({ activeViewId: existing.viewId });
        return;
      }
      const { settings } = get();
      const viewId = summary.id;
      // 重启前排队没发出去的消息：恢复后暂停，等用户点「继续」
      const queue = loadQueue(summary.id);
      const conv: Conversation = {
        viewId,
        agent: summary.agent,
        projectPath: summary.projectPath,
        sessionId: summary.id,
        title: summary.title,
        rows: [],
        loading: true,
        runState: "idle",
        permissionMode: settings.defaultPermissionModes[summary.agent],
        model: settings.defaultModels[summary.agent],
        effort: settings.defaultEfforts[summary.agent],
        queue,
        ...(queue.length ? { queuePaused: "stopped" as const } : {}),
      };
      set((state) => ({
        conversations: { ...state.conversations, [viewId]: conv },
        activeViewId: viewId,
      }));
      try {
        const result = await hcode.invoke("sessions:load", {
          agent: summary.agent,
          id: summary.id,
          projectPath: summary.projectPath,
        });
        patchConversation(viewId, { rows: result.rows, loading: false });
      } catch (error) {
        patchConversation(viewId, { loading: false, loadError: errorMessage(error) });
      }
    },

    newChat(projectPath, agentOverride) {
      const { settings, conversations } = get();
      const agent = agentOverride ?? settings.defaultAgent;
      // 同一项目已有空白草稿时直接复用
      const draft = Object.values(conversations).find(
        (conv) => conv.projectPath === projectPath && !conv.sessionKey && !conv.sessionId && !conv.compareId,
      );
      if (draft) {
        set({ activeViewId: draft.viewId });
        if (agentOverride && draft.agent !== agentOverride) get().setDraftAgent(agentOverride);
        return;
      }
      const viewId = `draft-${Date.now()}-${++draftSeq}`;
      set((state) => ({
        conversations: { ...state.conversations, [viewId]: draftConversation(viewId, projectPath, agent) },
        activeViewId: viewId,
      }));
    },

    setDraftAgent(agent) {
      const conv = activeConversation();
      if (!conv || conv.sessionKey || conv.sessionId || conv.agent === agent) return;
      const { settings } = get();
      patchConversation(conv.viewId, {
        agent,
        permissionMode: settings.defaultPermissionModes[agent],
        model: settings.defaultModels[agent],
        effort: settings.defaultEfforts[agent],
        activeModel: undefined,
      });
      void get().loadModels(agent);
    },

    setDraftProject(projectPath) {
      const conv = activeConversation();
      if (!conv || conv.sessionKey || conv.sessionId || conv.projectPath === projectPath) return;
      patchConversation(conv.viewId, { projectPath });
      get().toggleProject(projectPath, true);
    },

    async loadModels(agent) {
      if (get().models[agent]) return;
      set((state) => ({ models: { ...state.models, [agent]: AGENTS[agent].models } }));
      try {
        const list = await hcode.invoke("agent:models", agent);
        set((state) => ({ models: { ...state.models, [agent]: list } }));
      } catch {
        // 保留内置选项
      }
    },

    async send(text, images = [], files = []) {
      const { activeViewId } = get();
      return activeViewId ? sendConversation(activeViewId, text, images, files) : false;
    },

    async startCompare(agents, text, images, files) {
      const base = activeConversation();
      if (!base || base.sessionKey || base.sessionId) return false;
      const compareId = crypto.randomUUID();
      const siblings = agents
        .filter((agent, index) => agent !== base.agent && agents.indexOf(agent) === index)
        .map((agent) => ({ ...draftConversation(`draft-${Date.now()}-${++draftSeq}`, base.projectPath, agent), compareId }));
      set((state) => ({
        conversations: {
          ...state.conversations,
          [base.viewId]: { ...state.conversations[base.viewId]!, compareId },
          ...Object.fromEntries(siblings.map((conv) => [conv.viewId, conv])),
        },
      }));
      for (const conv of siblings) void get().loadModels(conv.agent);
      const results = await Promise.all(
        [base.viewId, ...siblings.map((conv) => conv.viewId)].map((viewId) => sendConversation(viewId, text, images, files)),
      );
      return results.some(Boolean);
    },

    async sendGroup(text, images, files) {
      const active = activeConversation();
      if (!active) return false;
      const results = await Promise.all(groupOf(active).map(async (conv) => {
        if (conv.runState === "running" || conv.runState === "awaitingApproval") {
          enqueueConversation(conv.viewId, text, images, files);
          return true;
        }
        return sendConversation(conv.viewId, text, images, files);
      }));
      return results.some(Boolean);
    },

    enqueue(text, images, files) {
      const conv = activeConversation();
      if (conv) enqueueConversation(conv.viewId, text, images, files);
    },

    removeQueued(id) {
      const conv = activeConversation();
      if (conv) patchConversation(conv.viewId, { queue: conv.queue.filter((item) => item.id !== id) });
    },

    resumeQueue() {
      const conv = activeConversation();
      if (!conv) return;
      patchConversation(conv.viewId, { queuePaused: undefined });
      drainQueue(conv.viewId);
    },

    async interrupt() {
      const active = activeConversation();
      if (!active) return;
      // 用户主动停止后保留队列但不自动发送；对比组里的会话一起停止
      await Promise.all(groupOf(active).map(async (conv) => {
        if (!conv.sessionKey) return;
        patchConversation(conv.viewId, { queuePaused: "stopped" });
        await hcode.invoke("chat:interrupt", conv.sessionKey);
      }));
    },

    async setPermissionMode(mode) {
      const conv = activeConversation();
      if (!conv) return;
      patchConversation(conv.viewId, { permissionMode: mode });
      if (conv.sessionKey) {
        await hcode.invoke("chat:setPermissionMode", conv.sessionKey, mode).catch(() => undefined);
      }
    },

    async setModel(model) {
      const conv = activeConversation();
      if (!conv) return;
      patchConversation(conv.viewId, { model });
      if (conv.sessionKey) await hcode.invoke("chat:setModel", conv.sessionKey, model).catch(() => undefined);
    },

    async setEffort(effort) {
      const conv = activeConversation();
      if (!conv) return;
      patchConversation(conv.viewId, { effort });
      await get().updateSettings({ defaultEfforts: { [conv.agent]: effort } });
    },

    async respondPermission(interactionId, decision) {
      await hcode.invoke("permission:respond", interactionId, decision);
    },

    async addProject() {
      const project = await hcode.invoke("projects:add");
      if (!project) return;
      await get().refreshProjects();
      get().toggleProject(project.path, true);
      // 正在编辑的草稿直接挪到新项目，保留已输入的内容
      const conv = activeConversation();
      if (conv && !conv.sessionKey && !conv.sessionId) get().setDraftProject(project.path);
      else get().newChat(project.path);
    },

    async setProjectPinned(path, pinned) {
      await hcode.invoke("projects:setPinned", path, pinned);
      await get().refreshProjects();
    },

    async removeProject(path) {
      await hcode.invoke("projects:remove", path);
      await get().refreshProjects();
    },

    async reorderProjects(activePath, overPath) {
      const projects = get().projects;
      const from = projects.findIndex((project) => project.path === activePath);
      const to = projects.findIndex((project) => project.path === overPath);
      if (from === -1 || to === -1 || from === to) return;
      // 先乐观更新，避免松手后项目弹回原位再跳到新位置
      const next = arrayMove(projects, from, to);
      set({ projects: next });
      await hcode.invoke("projects:reorder", next.map((project) => project.path));
      await get().refreshProjects();
    },

    async renameSession(summary, title) {
      await hcode.invoke("sessions:rename", { agent: summary.agent, id: summary.id, projectPath: summary.projectPath }, title);
      const conv = Object.values(get().conversations).find((c) => c.sessionId === summary.id);
      if (conv) patchConversation(conv.viewId, { title });
      await get().loadSessions(summary.projectPath);
    },

    async deleteSession(summary) {
      const conv = Object.values(get().conversations).find((c) => c.sessionId === summary.id);
      try {
        // 先关闭主进程里的活动会话，避免 CLI 进程继续写已删除的会话文件
        if (conv?.sessionKey) await hcode.invoke("chat:close", conv.sessionKey);
        await hcode.invoke("sessions:delete", { agent: summary.agent, id: summary.id, projectPath: summary.projectPath });
      } catch (error) {
        toast(`删除失败：${errorMessage(error)}`, { variant: "warning" });
        return;
      }
      discardPersisted(conv ?? { sessionId: summary.id, projectPath: summary.projectPath });
      if (conv) {
        set((state) => {
          const { [conv.viewId]: _removed, ...rest } = state.conversations;
          return {
            conversations: rest,
            activeViewId: state.activeViewId === conv.viewId ? null : state.activeViewId,
          };
        });
      }
      await get().loadSessions(summary.projectPath);
    },

    async forkFromMessage(rowId, mode) {
      const conv = activeConversation();
      if (!conv?.sessionId || !AGENTS[conv.agent].fork) return;
      const users = conv.rows.filter((row) => row.kind === "userInput");
      const turnIndex = users.findIndex((row) => row.rowId === rowId);
      const row = users[turnIndex];
      if (!row) return;
      let summary: SessionSummary | null;
      try {
        summary = await hcode.invoke("sessions:fork", {
          ref: { agent: conv.agent, id: conv.sessionId, projectPath: conv.projectPath },
          turnIndex,
          turnCount: users.length,
          mode,
        });
      } catch (error) {
        toast(`分叉失败：${errorMessage(error)}`, { variant: "warning" });
        return;
      }
      // 回退到第一条消息之前没有可保留的内容，直接开新会话
      if (!summary) get().newChat(conv.projectPath, conv.agent);
      const viewId = summary?.id ?? get().activeViewId;
      if (mode === "rewind" && viewId) {
        // 在新视图的输入框挂载前写入草稿
        const { images, files } = rowAttachments(row);
        drafts.set(viewId, row.text);
        imageDrafts.set(viewId, images);
        fileDrafts.set(viewId, files);
      }
      if (summary) {
        await get().openSession(summary);
        void get().loadSessions(conv.projectPath);
      }
    },

    async retryMessage(rowId) {
      const conv = activeConversation();
      const row = conv?.rows.find((item) => item.rowId === rowId);
      if (!conv || row?.kind !== "userInput" || conv.runState === "running" || conv.runState === "awaitingApproval") return;
      const { images, files } = rowAttachments(row);
      await sendConversation(conv.viewId, row.text, images, files);
    },

    editMessage(rowId) {
      const conv = activeConversation();
      const row = conv?.rows.find((item) => item.rowId === rowId);
      if (!conv || row?.kind !== "userInput") return;
      const { images, files } = rowAttachments(row);
      set({ composerPrefill: { viewId: conv.viewId, text: row.text, images, files } });
    },

    async updateSettings(patch) {
      const settings = await hcode.invoke("settings:set", patch);
      set({ settings });
      if (patch.theme) useUiStore.getState().setTheme(patch.theme);
      if (patch.agentPaths !== undefined) set({ agentStatuses: await hcode.invoke("agent:status") });
    },

    setSidebarCollapsed(collapsed) {
      set({ sidebarCollapsed: collapsed });
    },

    setSettingsOpen(open) {
      set({ settingsOpen: open });
    },

    async closeActiveView() {
      const { activeViewId, conversations } = get();
      if (!activeViewId) return;
      const conv = conversations[activeViewId];
      if (!conv) return;
      if (conv.runState === "running" || conv.runState === "awaitingApproval") {
        toast("任务运行中，请先停止任务再关闭会话", { variant: "warning" });
        return;
      }
      if (conv.sessionKey) {
        try {
          await hcode.invoke("chat:close", conv.sessionKey);
        } catch (error) {
          toast(`关闭会话失败：${errorMessage(error)}`, { variant: "warning" });
          return;
        }
      }
      discardPersisted(conv);
      drafts.delete(activeViewId);
      imageDrafts.delete(activeViewId);
      fileDrafts.delete(activeViewId);
      set((state) => {
        if (!state.conversations[activeViewId]) return state;
        const viewIds = Object.keys(state.conversations);
        const index = viewIds.indexOf(activeViewId);
        const { [activeViewId]: _removed, ...rest } = state.conversations;
        return {
          conversations: rest,
          activeViewId: state.activeViewId === activeViewId
            ? viewIds[index - 1] ?? viewIds[index + 1] ?? null
            : state.activeViewId,
        };
      });
    },

    activateView(viewId) {
      if (get().conversations[viewId]) set({ activeViewId: viewId });
    },

    markViewed() {
      const { activeViewId, conversations } = get();
      const active = activeViewId ? conversations[activeViewId] : undefined;
      if (!active) return;
      const stale = Object.values(conversations).filter(
        (conv) => conv.unread && (conv.viewId === active.viewId || (!!active.compareId && conv.compareId === active.compareId)),
      );
      if (stale.length === 0) return;
      set((state) => ({
        conversations: {
          ...state.conversations,
          ...Object.fromEntries(stale.map((conv) => [conv.viewId, { ...state.conversations[conv.viewId]!, unread: undefined }])),
        },
      }));
    },
  };
});

// 排队消息变化时写入 localStorage；按数组引用判断，流式输出时几乎没有开销
const savedQueues = new Map<string, QueuedMessage[]>();
useAppStore.subscribe((state) => {
  for (const conv of Object.values(state.conversations)) {
    if (!conv.sessionId || conv.compareId || savedQueues.get(conv.viewId) === conv.queue) continue;
    savedQueues.set(conv.viewId, conv.queue);
    saveQueue(conv.sessionId, conv.queue);
  }
});

export function useActiveConversation(): Conversation | undefined {
  return useAppStore((state) =>
    state.activeViewId ? state.conversations[state.activeViewId] : undefined,
  );
}
