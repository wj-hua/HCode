/** HTML 预览地址只在当前预览生命周期有效，不向页面暴露文件系统路径或 IPC。 */
export const HTML_PREVIEW_SCHEME = "hcode-preview";
export interface HtmlPreviewProof { source: import("./remoteControl.js").RemoteRowSource; rowId: number }
export interface HtmlPreviewLease { id: string; url: string }
