// HCode shim：替换 ZCode 原文件（原实现依赖 ZCode 的 services/store 层）。
// 只提供 ZCode 卡片实际用到的 fileService 能力，经 IPC 由主进程实现。
import { hcode } from "@app/bridge";
import { inferImageMediaType } from "@/lib/codeViewer.js";
import type { FileMediaPreview } from "@zcode/shared";
import type { ReactNode } from "react";

const services = {
  fileService: {
    async stat(params: { path: string }) {
      const info = await hcode.invoke("fs:stat", params.path);
      return info ? { ...info, isFile: !info.isDirectory } : null;
    },
    async readMediaPreview({ path }: { path: string }): Promise<FileMediaPreview> {
      const mediaType = inferImageMediaType(path);
      if (!mediaType) throw new Error("不支持的图片类型");
      const bytes = await hcode.invoke("fs:readMedia", path);
      if (!bytes?.length) throw new Error("图片无法读取、为空或超过 10 MiB");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mediaType }));
      });
      return { path, mediaType, dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1), totalBytes: bytes.length };
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
