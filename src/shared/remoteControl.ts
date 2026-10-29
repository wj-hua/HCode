// 远程操控：本机界面查询的状态，以及只对远程客户端开放的快照接口。
import type { ChatStateEvent, ConversationRow, PermissionRequestEvent } from "./types.js";

export type RemoteRowSource = { sessionKey: string; projectPath?: string } | { ref: import("./types.js").SessionRef };
export interface RemoteFileChange { path: string; additions: number; deletions: number; hasPatch: boolean }
export type RemoteToolRow = Extract<ConversationRow, { kind: "toolCall" }> & {
  remoteDetails: { ref: string; changes: RemoteFileChange[] };
};
/** 仅 HTTP 摘要行携带详情引用；桌面和完整导出继续使用原始工具行。 */
export function isRemoteToolRow(row: ConversationRow): row is RemoteToolRow {
  return row.kind === "toolCall" && "remoteDetails" in row;
}

/** 相对地址兼容根路径与反向代理子路径，图片内容始终经过远程登录鉴权。 */
export const REMOTE_MEDIA_PATH = "api/media/";

export type RemoteControlState = "off" | "starting" | "listening" | "error";

export interface TunnelStatus {
  /** off：未配置隧道或远程操控已关闭。 */
  state: "off" | "connecting" | "connected" | "error";
  error?: string;
}

export interface RemoteControlStatus {
  state: RemoteControlState;
  /** 本地服务实际监听的端口；未监听时省略。 */
  port?: number;
  /** 在线的远程事件连接数。 */
  clients: number;
  /** 通知事件流的在线订阅数。 */
  notificationSubscribers: number;
  error?: string;
  tunnel: TunnelStatus;
}

/**
 * 通知事件流（GET /api/notifications/stream，SSE `event: notification`）的公开协议。
 * id 形如 `<启动标识>.<序号>`，可直接作为对接方的去重键；包含会话列表标题，不含完整对话、命令或错误详情。
 */
export interface NotificationFeedEvent {
  id: string;
  type: "done" | "error" | "approval";
  sessionKey: string;
  sessionId?: string;
  agent: import("./types.js").AgentKind;
  /** 项目目录名。 */
  project: string;
  /** 项目绝对路径，即 HCode 项目的唯一键；远程网页按它与 sessionId 定位会话。 */
  projectPath: string;
  /** 会话列表标题，单行、最多 120 个 Unicode 码点；历史尚不可用时省略。 */
  title?: string;
  /** 等待审批时的工具名。 */
  tool?: string;
  /** 完成事件中本轮最后一条回复的开头几句，单行纯文本、最多 100 个 Unicode 码点；本轮没有回复时省略。 */
  summary?: string;
  /** 毫秒时间戳。 */
  at: number;
}

/** 远程客户端打开活动会话时获取的完整状态；seq 之前（含）的事件已包含在快照里。 */
export interface RemoteSessionSnapshot {
  earlierRows?: import("./types.js").SessionLoadResult["earlierRows"];
  seq: number;
  rows: ConversationRow[];
  state: ChatStateEvent | null;
  permissions: PermissionRequestEvent[];
}

/** 只对远程客户端开放的 invoke 通道（本机窗口不需要，因此不在 ipc.ts 中）。 */
export interface RemoteOnlyInvokeMap {
  "tools:detail": [[ref: string], Extract<ConversationRow, { kind: "toolCall" }>];
  "sessions:refresh": [[ref: import("./types.js").SessionRef, firstRowId?: number], import("./types.js").SessionLoadResult];
  "sessions:page": [[ref: import("./types.js").SessionRef, beforeRowId?: number], import("./types.js").SessionLoadResult];
  /** 当前活动会话的最新状态。 */
  "chat:live": [[], ChatStateEvent[]];
  "chat:snapshot": [[sessionKey: string], RemoteSessionSnapshot | null];
}
