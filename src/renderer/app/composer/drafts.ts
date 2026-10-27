import type { FileInput, ImageInput } from "@hcode/shared/types";

// 切换会话时保留各自未发送的草稿（按 viewId）；分叉 / 回退时也用它预填输入框
export const drafts = new Map<string, string>();
export const imageDrafts = new Map<string, ImageInput[]>();
export const fileDrafts = new Map<string, FileInput[]>();
