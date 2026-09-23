// HCode shim：替换 ZCode 原文件。ZCode 的 Start Plan 套餐余额面板在 HCode 中不适用。
/* eslint-disable @typescript-eslint/no-explicit-any */
export type ChatStartPlanBalanceConfig = Record<string, any>;

export function hasChatStartPlanBalance(_config: ChatStartPlanBalanceConfig | undefined): boolean {
  return false;
}

export function ChatStartPlanBalancePanel(_props: Record<string, any>): null {
  return null;
}
