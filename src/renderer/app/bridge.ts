import type { HCodeBridge } from "@hcode/shared/ipc";
import { createRemoteBridge } from "./remoteBridge";

declare global {
  interface Window {
    hcode?: HCodeBridge;
  }
}

/** 本机窗口由 preload 注入；普通浏览器（远程操控）里没有 preload，改走 HTTP。 */
// 单元测试在 Node 中导入时没有 window。
const injected = globalThis.window?.hcode;
export const remoteBridge = injected ? null : createRemoteBridge();
export const hcode: HCodeBridge = injected ?? remoteBridge!;
export const isRemote = remoteBridge !== null;
