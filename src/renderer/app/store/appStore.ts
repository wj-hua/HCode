// HCode 渲染进程主状态：项目、会话列表、打开的对话、审批请求。
import { create } from "zustand";
import type {
  AgentKind,
  AgentStatus,
  ModelOption,
  ChatRunState,
  ConversationRow,
  FileInput,
  ImageInput,
  PermissionDecision,
  PermissionMode,
  PermissionRequestEvent,
  Project,
  SessionSummary,
  Settings,
} from "@hcode/shared/types";
import { DEFAULT_SETTINGS } from "@hcode/shared/types";
import { AGENTS } from "@hcode/shared/agents";
import { toast } from "@/components/ui/toast.js";
import { hcode } from "../bridge";
import { applyRowOps } from "../rows";
import { useUiStore } from "./uiStore";

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
  error?: string;
  permissionMode: PermissionMode;
  /** 用户选择的模型（空串 = CLI 默认）。 */
  model: string;
  /** Claude 实际使用的模型 id（来自 init）。 */
  activeModel?: string;
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
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  respondPermission(interactionId: string, decision: PermissionDecision): Promise<void>;
  addProject(): Promise<void>;
  setProjectPinned(path: string, pinned: boolean): Promise<void>;
  removeProject(path: string): Promise<void>;
  renameSession(summary: SessionSummary, title: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  setSidebarCollapsed(collapsed: boolean): void;
  setSettingsOpen(open: boolean): void;
}

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // ipcRenderer.invoke 的错误带有 "Error invoking remote method 'x': Error: " 前缀
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
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

  const subscribeEvents = () => {
    hcode.on("chat:rows", ({ sessionKey, ops }) => {
      const conv = findBySessionKey(sessionKey);
      if (!conv) return;
      patchConversation(conv.viewId, { rows: applyRowOps(conv.rows, ops) });
    });
    hcode.on("chat:state", (event) => {
      const conv = findBySessionKey(event.sessionKey);
      if (!conv) return;
      patchConversation(conv.viewId, {
        runState: event.state,
        error: event.error,
        permissionMode: event.permissionMode,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.model ? { activeModel: event.model } : {}),
      });
    });
    hcode.on("permission:requested", (event) => {
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
      set((state) => ({ sessions: { ...state.sessions, [projectPath]: list } }));
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
        (conv) => conv.projectPath === projectPath && !conv.sessionKey && !conv.sessionId,
      );
      if (draft) {
        set({ activeViewId: draft.viewId });
        if (agentOverride && draft.agent !== agentOverride) get().setDraftAgent(agentOverride);
        return;
      }
      const viewId = `draft-${Date.now()}-${++draftSeq}`;
      set((state) => ({
        conversations: {
          ...state.conversations,
          [viewId]: {
            viewId,
            agent,
            projectPath,
            rows: [],
            loading: false,
            runState: "idle",
            permissionMode: settings.defaultPermissionModes[agent],
            model: settings.defaultModels[agent],
          },
        },
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
      const conv = activeConversation();
      if (!conv || (!text.trim() && images.length === 0 && files.length === 0)) return false;
      const sessionKey = conv.sessionKey ?? crypto.randomUUID();
      const resumeSessionId = conv.sessionKey ? undefined : conv.sessionId;
      patchConversation(conv.viewId, { sessionKey, runState: "running", error: undefined });
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
        });
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
    },

    async interrupt() {
      const conv = activeConversation();
      if (conv?.sessionKey) await hcode.invoke("chat:interrupt", conv.sessionKey);
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

    async renameSession(summary, title) {
      await hcode.invoke("sessions:rename", { agent: summary.agent, id: summary.id, projectPath: summary.projectPath }, title);
      const conv = Object.values(get().conversations).find((c) => c.sessionId === summary.id);
      if (conv) patchConversation(conv.viewId, { title });
      await get().loadSessions(summary.projectPath);
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
  };
});

export function useActiveConversation(): Conversation | undefined {
  return useAppStore((state) =>
    state.activeViewId ? state.conversations[state.activeViewId] : undefined,
  );
}
