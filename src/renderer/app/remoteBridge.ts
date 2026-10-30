// 远程操控：普通浏览器里没有 preload，window.hcode 改由 HTTP + SSE 实现。
// 断线重连后先取活动会话列表，再逐个会话取快照覆盖本地内容；快照 seq 之前的事件丢弃，避免流式文字重复。
import { EVENT_CHANNELS, type EventChannel, type HCodeBridge, type InvokeChannel } from "@hcode/shared/ipc";
import type { RemoteOnlyInvokeMap, RemoteSessionSnapshot } from "@hcode/shared/remoteControl";
import type { ChatStateEvent, PermissionRequestEvent, SessionRef, SessionLoadResult, Settings, SettingsPatch } from "@hcode/shared/types";

const HEADERS = { "Content-Type": "application/json", "X-HCode-Remote": "1" };
const REMOTE_THEME_KEY = "hcode-remote-theme";

function readRemoteTheme(): Settings["theme"] {
  try {
    const theme = localStorage.getItem(REMOTE_THEME_KEY);
    if (theme === "system" || theme === "light" || theme === "dark") return theme;
  } catch { /* 浏览器禁用存储时仍可在当前页面切换主题。 */ }
  return "dark";
}

/** 本机专用功能在远程返回空结果，界面按“没有数据”显示，不弹错误。 */
const EMPTY_RESULTS: Partial<Record<InvokeChannel, unknown>> = {
  "collaboration:presentation": { entries: [], errors: [] },
  "collaboration:recoveryIssues": [],
  "collaboration:list": [],
  "collaboration:capabilities": [],
  "collaboration:draftList": [],
  "collaboration:codeDraftList": [],
  "collaboration:expertDraftList": [],
  "agentInvocation:list": [],
  "git:worktree": null,
};

export class RemoteUnauthorizedError extends Error {}

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { method: "POST", headers: HEADERS, credentials: "same-origin", body: JSON.stringify(body), signal });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; result?: unknown; error?: string };
  if (response.status === 401 && path === "api/invoke") throw new RemoteUnauthorizedError(data.error ?? "需要登录");
  if (!response.ok || !data.ok) throw new Error(data.error ?? `请求失败（${response.status}）`);
  return data.result;
}

/** 附件暂存走同一个 invoke 接口；fetch 拿不到上传进度，这里改用 XHR。 */
function stageAttachment(file: { name: string; data: string }, onProgress: (ratio: number) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "api/invoke");
    for (const [name, value] of Object.entries(HEADERS)) xhr.setRequestHeader(name, value);
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onload = () => {
      const data = (xhr.response ?? {}) as { ok?: boolean; result?: unknown; error?: string };
      if (xhr.status === 401) {
        location.reload();
        reject(new RemoteUnauthorizedError(data.error ?? "需要登录"));
      } else if (xhr.status < 200 || xhr.status >= 300 || !data.ok) {
        reject(new Error(data.error ?? `请求失败（${xhr.status}）`));
      } else {
        resolve(data.result as string);
      }
    };
    xhr.onerror = () => reject(new Error("网络连接中断"));
    xhr.onabort = () => reject(signal?.reason ?? new DOMException("已取消上传", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(JSON.stringify({ channel: "fs:stageAttachment", args: [file] }));
  });
}

export function remoteLogin(token: string): Promise<unknown> {
  return post("api/login", { token }, AbortSignal.timeout(15_000));
}

/** 浅合并到第二层，与主进程按 CLI 合并设置的效果一致。 */
function mergeLocal(settings: Settings, patch: SettingsPatch): Settings {
  const next = { ...settings } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = next[key];
    next[key] = value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object"
      ? { ...current, ...value }
      : value;
  }
  return next as unknown as Settings;
}

type Frame = { channel: EventChannel; payload: unknown; id: number };
/** syncing：事件流已连上、界面可操作，但仍有会话快照在下载，这些会话的内容可能暂时落后。 */
export type RemoteConnectionState = "connecting" | "syncing" | "connected" | "disconnected";

const LIVE_TIMEOUT_MS = 15_000;
/** 长对话快照经慢隧道可能要几十秒；超时只用来发现卡死的请求，不能按普通接口设得太短。 */
const SNAPSHOT_TIMEOUT_MS = 60_000;
const CALL_TIMEOUTS: Partial<Record<string, number>> = { "chat:live": LIVE_TIMEOUT_MS, "chat:snapshot": SNAPSHOT_TIMEOUT_MS };
const EVENT_RETRY_MS = 3000;
const LOGIN_CHECK_RETRY_MS = 5000;
const SNAPSHOT_RETRY_BASE_MS = 3000;
const SNAPSHOT_RETRY_MAX_MS = 30_000;

export function createRemoteBridge(): HCodeBridge & {
  connect(signal?: AbortSignal): Promise<void>;
  disconnect(): void;
  onConnectionChange(listener: (state: RemoteConnectionState) => void): () => void;
  loadEarlier(ref: SessionRef, beforeRowId: number): Promise<SessionLoadResult>;
  setViewedSessions(keys: string[]): void;
  stageAttachment: typeof stageAttachment;
  loadToolDetails(ref: string, signal?: AbortSignal): Promise<import("@hcode/shared/types").ConversationRow & { kind: "toolCall" }>;
  refreshSession(sessionKey: string): Promise<void>;
  refreshHistory(ref: SessionRef, firstRowId?: number): Promise<SessionLoadResult>;
} {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const latestStates = new Map<string, ChatStateEvent>();
  const emit = (channel: EventChannel, payload: unknown) => {
    if (channel === "chat:state") {
      const state = payload as ChatStateEvent;
      latestStates.set(state.sessionKey, state);
    }
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  };
  // 设置改动只在本页面生效：主题、模型选择不影响电脑上的 HCode。
  let settings: Settings | null = null;
  const pendingPermissions = new Map<string, PermissionRequestEvent>();
  const viewedSessions = new Set<string>();
  const snapshotRequests = new Map<string, AbortController>();
  const clientId = crypto.randomUUID();
  const floors = new Map<string, number>();
  /** 事件流刚连上、活动会话列表返回前收到的全部事件。 */
  let buffer: Frame[] | null = null;
  /** 等待快照的会话 → 本次快照请求发出后收到的该会话事件，快照到达后按 seq 过滤再补发。 */
  const awaiting = new Map<string, Frame[]>();
  const snapshotTimers = new Set<ReturnType<typeof setTimeout>>();
  let source: EventSource | null = null;
  let eventRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let syncGeneration = 0;
  let connection: RemoteConnectionState = "disconnected";
  const connectionListeners = new Set<(state: RemoteConnectionState) => void>();
  const setConnection = (state: RemoteConnectionState) => {
    connection = state;
    for (const listener of connectionListeners) listener(state);
  };

  const call = async (channel: string, args: unknown[], signal?: AbortSignal) => {
    const timeout = CALL_TIMEOUTS[channel];
    const signals = [signal, timeout ? AbortSignal.timeout(timeout) : undefined].filter((item): item is AbortSignal => item !== undefined);
    try {
      return await post("api/invoke", { channel, args }, signals.length ? AbortSignal.any(signals) : undefined);
    } catch (error) {
      // 口令被重新生成或电脑上关闭了远程操控：回到登录页。
      if (error instanceof RemoteUnauthorizedError) location.reload();
      throw error;
    }
  };

  const deliver = (frame: Frame) => {
    const { channel, payload, id } = frame;
    const sessionKey = (payload as { sessionKey?: unknown } | null)?.sessionKey;
    if (channel === "chat:rows" && typeof sessionKey === "string" && !viewedSessions.has(sessionKey)) return;
    if (typeof sessionKey === "string") {
      const waiting = awaiting.get(sessionKey);
      if (waiting) {
        waiting.push(frame);
        return;
      }
      if (id <= (floors.get(sessionKey) ?? 0)) return;
    }
    if (channel === "permission:requested") {
      const event = payload as PermissionRequestEvent;
      pendingPermissions.set(event.interactionId, event);
    } else if (channel === "permission:resolved") {
      pendingPermissions.delete((payload as { interactionId: string }).interactionId);
    }
    emit(channel, payload);
  };

  /** 作废进行中的同步：迟到的旧快照按代次丢弃，等待中的快照重试一并取消。 */
  const cancelSync = () => {
    syncGeneration++;
    buffer = null;
    awaiting.clear();
    for (const controller of snapshotRequests.values()) controller.abort();
    snapshotRequests.clear();
    for (const timer of snapshotTimers) clearTimeout(timer);
    snapshotTimers.clear();
  };

  /** 断线期间已在电脑上处理掉的审批不会再出现在快照里，补发 resolved 让界面关闭审批卡片。 */
  const resolveMissingPermissions = (inScope: (sessionKey: string) => boolean, current: PermissionRequestEvent[]) => {
    const kept = new Set(current.map((permission) => permission.interactionId));
    for (const [interactionId, permission] of pendingPermissions) {
      const sessionKey = permission.sessionKey;
      if (!inScope(sessionKey) || kept.has(interactionId)) continue;
      pendingPermissions.delete(interactionId);
      emit("permission:resolved", { sessionKey, interactionId });
    }
  };

  const applySnapshot = (state: ChatStateEvent, snapshot: RemoteSessionSnapshot | null) => {
    const { sessionKey } = state;
    const frames = awaiting.get(sessionKey) ?? [];
    awaiting.delete(sessionKey);
    resolveMissingPermissions((key) => key === sessionKey, snapshot?.permissions ?? []);
    // 快照为空表示会话在取列表后已结束，只补发期间收到的事件。
    if (snapshot) {
      floors.set(sessionKey, snapshot.seq);
      emit("chat:state", snapshot.state ?? state);
      emit("chat:rows", { sessionKey, ops: [{ op: "reset", rows: snapshot.rows }], ...(snapshot.earlierRows ? { earlierRows: snapshot.earlierRows } : {}) });
      for (const permission of snapshot.permissions) {
        pendingPermissions.set(permission.interactionId, permission);
        emit("permission:requested", permission);
      }
    }
    for (const frame of frames) deliver(frame);
    if (awaiting.size === 0) setConnection("connected");
  };

  /**
   * 单个会话的快照失败只退避重试它自己，不断开事件流、不影响其他会话。
   * 每次请求前清空该会话的暂存事件：新快照在请求到达电脑后生成，已包含此前的所有事件。
   */
  const syncSession = async (events: EventSource, generation: number, state: ChatStateEvent, attempt = 0, manual = false): Promise<void> => {
    const controller = new AbortController();
    const current = () => source === events && generation === syncGeneration && viewedSessions.has(state.sessionKey) && snapshotRequests.get(state.sessionKey) === controller;
    snapshotRequests.get(state.sessionKey)?.abort();
    snapshotRequests.set(state.sessionKey, controller);
    awaiting.set(state.sessionKey, []);
    try {
      const snapshot = await call("chat:snapshot", [state.sessionKey], controller.signal) as RemoteSessionSnapshot | null;
      if (!current()) { if (manual) throw new Error("连接已变化，请重新刷新"); return; }
      applySnapshot(state, snapshot);
    } catch (error) {
      if (manual) {
        if (current()) {
          const frames = awaiting.get(state.sessionKey) ?? [];
          awaiting.delete(state.sessionKey);
          for (const frame of frames) deliver(frame);
          if (awaiting.size === 0) setConnection("connected");
        }
        throw error;
      }
      if (!current()) return;
      const timer = setTimeout(() => {
        snapshotTimers.delete(timer);
        if (source === events && generation === syncGeneration && viewedSessions.has(state.sessionKey) && awaiting.has(state.sessionKey) && !snapshotRequests.has(state.sessionKey)) void syncSession(events, generation, state, attempt + 1);
      }, Math.min(SNAPSHOT_RETRY_BASE_MS * 2 ** attempt, SNAPSHOT_RETRY_MAX_MS));
      snapshotTimers.add(timer);
    } finally {
      if (snapshotRequests.get(state.sessionKey) === controller) snapshotRequests.delete(state.sessionKey);
    }
  };

  /** 每次（重新）连上事件流：先取活动会话列表并立即更新运行状态，再按会话各自取快照补齐内容。 */
  const resync = async (events: EventSource) => {
    cancelSync();
    const generation = syncGeneration;
    buffer = [];
    setConnection("syncing");
    let live: RemoteOnlyInvokeMap["chat:live"][1];
    try {
      live = await call("chat:live", []) as RemoteOnlyInvokeMap["chat:live"][1];
    } catch {
      // 连列表都取不到说明请求通道不可用：重开事件流，连上后整体重来，不能停在假的已连接状态。
      if (source !== events || generation !== syncGeneration) return;
      setConnection("disconnected");
      if (eventRetryTimer) clearTimeout(eventRetryTimer);
      eventRetryTimer = setTimeout(() => {
        eventRetryTimer = null;
        if (source === events) openEvents();
      }, EVENT_RETRY_MS);
      return;
    }
    if (source !== events || generation !== syncGeneration) return;
    latestStates.clear();
    floors.clear();
    const liveKeys = new Set(live.map((state) => state.sessionKey));
    resolveMissingPermissions((key) => !liveKeys.has(key), []);
    for (const state of live) {
      emit("chat:state", state);
      if (viewedSessions.has(state.sessionKey)) syncSession(events, generation, state);
    }
    emit("sessions:indexChanged", { projectPaths: [] });
    const frames = buffer ?? [];
    buffer = null;
    for (const frame of frames) deliver(frame);
    if (awaiting.size === 0) setConnection("connected");
  };

  const openEvents = () => {
    if (eventRetryTimer) clearTimeout(eventRetryTimer);
    eventRetryTimer = null;
    source?.close();
    cancelSync();
    setConnection("connecting");
    const query = new URLSearchParams({ clientId });
    for (const key of viewedSessions) query.append("sessionKey", key);
    const events = new EventSource(`api/events?${query}`);
    source = events;
    // 每次（重新）连上都会先收到 hello，在此对齐断线期间错过的内容。
    events.addEventListener("hello", (message) => {
      if (source !== events) return;
      if (eventRetryTimer) clearTimeout(eventRetryTimer);
      eventRetryTimer = null;
      const hello = JSON.parse((message as MessageEvent<string>).data) as { permissions?: PermissionRequestEvent[] };
      if (hello.permissions) {
        resolveMissingPermissions(() => true, hello.permissions);
        for (const permission of hello.permissions) {
          pendingPermissions.set(permission.interactionId, permission);
          emit("permission:requested", permission);
        }
      }
      void resync(events);
    });
    for (const channel of EVENT_CHANNELS) {
      events.addEventListener(channel, (message) => {
        if (source !== events) return;
        const frame = { channel, payload: JSON.parse((message as MessageEvent<string>).data), id: Number((message as MessageEvent).lastEventId) || 0 };
        if (buffer) buffer.push(frame);
        else deliver(frame);
      });
    }
    events.onerror = () => {
      if (source !== events) return;
      cancelSync();
      setConnection("disconnected");
      if (events.readyState !== EventSource.CLOSED) return;
      // 浏览器不再自动重连（如服务返回 401）：检查登录后重新连接。
      eventRetryTimer = setTimeout(() => {
        eventRetryTimer = null;
        if (source !== events) return;
        void call("chat:live", []).then(
          () => { if (source === events) openEvents(); },
          () => {
            if (source === events) eventRetryTimer = setTimeout(() => {
              eventRetryTimer = null;
              if (source === events) openEvents();
            }, LOGIN_CHECK_RETRY_MS);
          },
        );
      }, EVENT_RETRY_MS);
    };
  };

  return {
    /** 只订阅当前查看的内容；切换时重建事件流并取消旧下载，hello 会补齐状态和审批。 */
    setViewedSessions(keys) {
      const next = new Set(keys);
      if (next.size === viewedSessions.size && [...next].every(key => viewedSessions.has(key))) return;
      viewedSessions.clear();
      for (const key of next) viewedSessions.add(key);
      if (source) openEvents();
    },
    async loadEarlier(ref, beforeRowId) {
      return await call("sessions:page", [ref, beforeRowId]) as SessionLoadResult;
    },
    async loadToolDetails(ref, signal) { return await call("tools:detail", [ref], signal) as import("@hcode/shared/types").ConversationRow & { kind: "toolCall" }; },
    async refreshSession(sessionKey) {
      const state = latestStates.get(sessionKey);
      if (!source || !state || !viewedSessions.has(sessionKey)) throw new Error("当前会话尚未连接，请重试");
      await syncSession(source, syncGeneration, state, 0, true);
    },
    async refreshHistory(ref, firstRowId) { return await call("sessions:refresh", [ref, firstRowId]) as SessionLoadResult; },
    remote: true,
    stageAttachment,
    onConnectionChange(listener) {
      connectionListeners.add(listener);
      listener(connection);
      return () => { connectionListeners.delete(listener); };
    },
    disconnect() {
      source?.close();
      cancelSync();
      source = null;
      if (eventRetryTimer) clearTimeout(eventRetryTimer);
      eventRetryTimer = null;
      setConnection("disconnected");
    },
    platform: "linux",
    getPathForFile: () => null,
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      listeners.set(channel, set);
      set.add(listener as (payload: unknown) => void);
      if (channel === "chat:state") for (const state of latestStates.values()) (listener as (payload: unknown) => void)(state);
      if (channel === "permission:requested") for (const permission of pendingPermissions.values()) (listener as (payload: unknown) => void)(permission);
      return () => set.delete(listener as (payload: unknown) => void);
    },
    async invoke(channel, ...args) {
      if (channel in EMPTY_RESULTS) return EMPTY_RESULTS[channel] as never;
      switch (channel) {
        case "fs:readMedia": {
          // HTTP JSON 不保留 Uint8Array；专用文件接口返回有界的 base64 内容。
          const encoded = await call(channel, args) as string | null;
          return (encoded === null ? null : Uint8Array.from(atob(encoded), character => character.charCodeAt(0))) as never;
        }
        case "sessions:load":
          return await call((args[1] as { complete?: boolean } | undefined)?.complete ? "sessions:load" : "sessions:page", [args[0]]) as never;
        case "settings:get":
          settings ??= { ...await call(channel, args) as Settings, theme: readRemoteTheme() };
          return settings as never;
        case "settings:set":
          settings = mergeLocal(settings ?? { ...await call("settings:get", []) as Settings, theme: readRemoteTheme() }, args[0] as SettingsPatch);
          if ((args[0] as SettingsPatch).theme) {
            try { localStorage.setItem(REMOTE_THEME_KEY, settings.theme); } catch { /* 存储不可用时只保留当前页面的设置。 */ }
          }
          return settings as never;
        case "app:copyText":
          await navigator.clipboard.writeText(args[0] as string);
          return undefined as never;
        case "app:openExternal":
          if (/^(https?|mailto):/i.test(args[0] as string)) window.open(args[0] as string, "_blank", "noopener");
          return undefined as never;
        // 电脑上的会话由电脑管理，手机关闭视图不结束它。
        case "chat:close":
        case "app:focusWindow":
          return undefined as never;
        default:
          return await call(channel, args) as never;
      }
    },
    /** 登录有效时打开事件流；未登录抛出 RemoteUnauthorizedError。 */
    async connect(signal) {
      setConnection("connecting");
      const timeout = AbortSignal.timeout(LIVE_TIMEOUT_MS);
      await post("api/invoke", { channel: "chat:live", args: [] }, signal ? AbortSignal.any([signal, timeout]) : timeout);
      signal?.throwIfAborted();
      openEvents();
    },
  };
}
