// HCode shim：替换 ZCode 原文件（原实现依赖 ZCode 的 services/store 层）。
export type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
export { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ZCodeState = Record<string, any>;
