// HCode shim：替换 ZCode 原文件（原实现依赖 ZCode 的 services/store 层）。
// 只提供 ZCode 卡片实际用到的 fileService 能力，经 IPC 由主进程实现。
import type { ReactNode } from "react";

const services = {
  fileService: {
    async stat(params: { path: string }) {
      const info = await window.hcode.invoke("fs:stat", params.path);
      return info ? { ...info, isFile: !info.isDirectory } : null;
    },
    async readMediaPreview() {
      return null;
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ServiceAccessor = any;

export function ServiceProvider({ children }: { services?: ServiceAccessor; children: ReactNode }) {
  return children;
}

export function useServices(): ServiceAccessor {
  return services;
}

export function useOptionalServices(): ServiceAccessor | null {
  return services;
}
