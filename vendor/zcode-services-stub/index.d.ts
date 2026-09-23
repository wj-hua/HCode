// HCode 不包含 ZCode 的 services 层；复制过来的 UI 文件只以 `import type` 引用这些名字。
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface BroadcastMessage {
  channel: string;
  payload: unknown;
  sourceWindowId?: number;
}
export type IServiceAccessor = any;
export type IUsageStatsService = any;
export type ISettingService = any;
export type IBroadcastService = any;
export type BroadcastClaimLease = any;
