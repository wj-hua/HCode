import type { HCodeBridge } from "@hcode/shared/ipc";

declare global {
  interface Window {
    hcode: HCodeBridge;
  }
}

export const hcode = window.hcode;
