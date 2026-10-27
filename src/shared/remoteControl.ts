// 远程操控：本机界面查询的状态，以及只对远程客户端开放的快照接口。
import type { ChatStateEvent, ConversationRow, PermissionRequestEvent } from "./types.js";

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
  error?: string;
  tunnel: TunnelStatus;
}

/** 远程客户端打开活动会话时获取的完整状态；seq 之前（含）的事件已包含在快照里。 */
export interface RemoteSessionSnapshot {
  seq: number;
  rows: ConversationRow[];
  state: ChatStateEvent | null;
  permissions: PermissionRequestEvent[];
}

/** 只对远程客户端开放的 invoke 通道（本机窗口不需要，因此不在 ipc.ts 中）。 */
export interface RemoteOnlyInvokeMap {
  /** 当前活动会话的最新状态。 */
  "chat:live": [[], ChatStateEvent[]];
  "chat:snapshot": [[sessionKey: string], RemoteSessionSnapshot | null];
}
