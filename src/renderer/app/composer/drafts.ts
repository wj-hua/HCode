import type { FileInput, ImageInput } from "@hcode/shared/types";

// 切换会话时保留各自未发送的草稿（按 viewId）；分叉 / 回退时也用它预填输入框
export const drafts = new Map<string, string>();
export const imageDrafts = new Map<string, ImageInput[]>();
export const fileDrafts = new Map<string, FileInput[]>();

/** 对比切换会重挂载输入框；发送确认只消费原值，不能覆盖等待期间的新输入。 */
export function consumeSubmittedDraft(viewId: string, text: string, images: ImageInput[], files: FileInput[]) {
  const remaining = {
    text: drafts.get(viewId) === text ? '' : drafts.get(viewId) ?? text,
    images: imageDrafts.get(viewId) === images ? [] : imageDrafts.get(viewId) ?? images,
    files: fileDrafts.get(viewId) === files ? [] : fileDrafts.get(viewId) ?? files,
  };
  drafts.set(viewId, remaining.text);
  imageDrafts.set(viewId, remaining.images);
  fileDrafts.set(viewId, remaining.files);
  return remaining;
}
