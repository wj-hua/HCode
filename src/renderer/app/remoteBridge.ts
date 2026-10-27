// 远程操控：普通浏览器里没有 preload，window.hcode 改由 HTTP + SSE 实现。
// 断线重连后先取活动会话快照覆盖本地内容，快照 seq 之前的事件丢弃，避免流式文字重复。
import { EVENT_CHANNELS, type EventChannel, type HCodeBridge, type InvokeChannel } from "@hcode/shared/ipc";
import type { RemoteOnlyInvokeMap, RemoteSessionSnapshot } from "@hcode/shared/remoteControl";
import type { ChatStateEvent, PermissionRequestEvent, Settings, SettingsPatch } from "@hcode/shared/types";

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
  "fs:stat": null,
  "fs:readText": null,
  "fs:readMedia": null,
};

export class RemoteUnauthorizedError extends Error {}

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { method: "POST", headers: HEADERS, credentials: "same-origin", body: JSON.stringify(body), signal });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; result?: unknown; error?: string };
  if (response.status === 401 && path === "api/invoke") throw new RemoteUnauthorizedError(data.error ?? "需要登录");
  if (!response.ok || !data.ok) throw new Error(data.error ?? `请求失败（${response.status}）`);
  return data.result;
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
export type RemoteConnectionState = "connecting" | "connected" | "disconnected";

export function createRemoteBridge(): HCodeBridge & {
  connect(signal?: AbortSignal): Promise<void>;
  disconnect(): void;
  onConnectionChange(listener: (state: RemoteConnectionState) => void): () => void;
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
  const pendingPermissions = new Map<string, string>();
  const floors = new Map<string, number>();
  let buffer: Frame[] | null = null;
  let source: EventSource | null = null;
  let eventRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let syncGeneration = 0;
  let connection: RemoteConnectionState = "disconnected";
  const connectionListeners = new Set<(state: RemoteConnectionState) => void>();
  const setConnection = (state: RemoteConnectionState) => {
    connection = state;
    for (const listener of connectionListeners) listener(state);
  };

  const call = async (channel: string, args: unknown[]) => {
    try {
      return await post("api/invoke", { channel, args }, channel === "chat:live" || channel === "chat:snapshot" ? AbortSignal.timeout(15_000) : undefined);
    } catch (error) {
      // 口令被重新生成或电脑上关闭了远程操控：回到登录页。
      if (error instanceof RemoteUnauthorizedError) location.reload();
      throw error;
    }
  };

  const deliver = ({ channel, payload, id }: Frame) => {
    const sessionKey = (payload as { sessionKey?: unknown } | null)?.sessionKey;
    if (typeof sessionKey === "string" && id <= (floors.get(sessionKey) ?? 0)) return;
    if (channel === "permission:requested") {
      const event = payload as PermissionRequestEvent;
      pendingPermissions.set(event.interactionId, event.sessionKey);
    } else if (channel === "permission:resolved") {
      pendingPermissions.delete((payload as { interactionId: string }).interactionId);
    }
    emit(channel, payload);
  };

  const resync = async (events: EventSource) => {
    const generation = ++syncGeneration;
    buffer ??= [];
    try {
      const live = await call("chat:live", []) as RemoteOnlyInvokeMap["chat:live"][1];
      const snapshots = await Promise.all(live.map((state) =>
        (call("chat:snapshot", [state.sessionKey]) as Promise<RemoteSessionSnapshot | null>).then((snapshot) => ({ state, snapshot }))));
      if (source !== events || generation !== syncGeneration) return;
      latestStates.clear();
      floors.clear();
      const stale = new Map(pendingPermissions);
      for (const { state, snapshot } of snapshots) {
        if (!snapshot) continue;
        floors.set(state.sessionKey, snapshot.seq);
        emit("chat:state", snapshot.state ?? state);
        emit("chat:rows", { sessionKey: state.sessionKey, ops: [{ op: "reset", rows: snapshot.rows }] });
        for (const permission of snapshot.permissions) {
          stale.delete(permission.interactionId);
          pendingPermissions.set(permission.interactionId, permission.sessionKey);
          emit("permission:requested", permission);
        }
      }
      // 断线期间已经处理掉的审批
      for (const [interactionId, sessionKey] of stale) {
        pendingPermissions.delete(interactionId);
        emit("permission:resolved", { sessionKey, interactionId });
      }
      emit("sessions:indexChanged", { projectPaths: [] });
      setConnection("connected");
    } catch {
      // SSE 已恢复但快照请求仍失败时也要继续恢复，不能等下一次断线。
      if (source === events && generation === syncGeneration) {
        setConnection("disconnected");
        if (eventRetryTimer) clearTimeout(eventRetryTimer);
        eventRetryTimer = setTimeout(() => {
          eventRetryTimer = null;
          if (source === events) openEvents();
        }, 3000);
      }
    } finally {
      if (source !== events || generation !== syncGeneration) return;
      const frames = buffer ?? [];
      buffer = null;
      for (const frame of frames) deliver(frame);
    }
  };

  const openEvents = () => {
    if (eventRetryTimer) clearTimeout(eventRetryTimer);
    eventRetryTimer = null;
    source?.close();
    syncGeneration++;
    buffer = null;
    setConnection("connecting");
    const events = new EventSource("api/events");
    source = events;
    // 每次（重新）连上都会先收到 hello，在此对齐断线期间错过的内容。
    events.addEventListener("hello", () => {
      if (source !== events) return;
      if (eventRetryTimer) clearTimeout(eventRetryTimer);
      eventRetryTimer = null;
      setConnection("connecting");
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
      syncGeneration++;
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
            }, 5000);
          },
        );
      }, 3000);
    };
  };

  return {
    remote: true,
    onConnectionChange(listener) {
      connectionListeners.add(listener);
      listener(connection);
      return () => { connectionListeners.delete(listener); };
    },
    disconnect() {
      source?.close();
      syncGeneration++;
      source = null;
      buffer = null;
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
      return () => set.delete(listener as (payload: unknown) => void);
    },
    async invoke(channel, ...args) {
      if (channel in EMPTY_RESULTS) return EMPTY_RESULTS[channel] as never;
      switch (channel) {
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
      const timeout = AbortSignal.timeout(15_000);
      await post("api/invoke", { channel: "chat:live", args: [] }, signal ? AbortSignal.any([signal, timeout]) : timeout);
      signal?.throwIfAborted();
      openEvents();
    },
  };
}
