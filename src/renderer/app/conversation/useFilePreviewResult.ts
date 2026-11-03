// 文件面板的按需读取与生命周期。迟到的响应不覆盖新文件，本机图片 URL 随面板释放。
import { useEffect, useState } from "react";
import { FILE_VIEWER_MAX_TEXT_BYTES } from "@/lib/codeViewer.js";
import { hcode, remoteBridge } from "../bridge";
import { errorMessage } from "../store/appStore";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
type FileResult =
  | { kind: "text"; content: string }
  | { kind: "image"; url: string }
  | { kind: "html" }
  | { kind: "remoteImage"; url: string }
  | { kind: "paged"; page: import("@hcode/shared/remoteControl").RemoteTextPage }
  | { kind: "missing"; candidates: string[] }
  | { kind: "notice"; notice: string };

export function useFilePreviewResult(path: string | undefined, workspacePath: string | undefined,
  relative: string | undefined, imageType: string | null, showsHtmlPage: boolean, canToggleHtml: boolean, revision: number) {
  const [result, setResult] = useState<FileResult | null>(null);
  useEffect(() => {
    // HTML 页面走隔离资源协议；只有切到源码时才读取文本，源码上限不能阻止页面加载。
    if (!path) { setResult(null); return; }
    let active = true;
    let imageUrl: string | null = null;
    setResult(null);
    const load = async (): Promise<FileResult> => {
      // 关联工作树的 HTML 仅通过正文对应的页面授权读取，不申请通用文件权限。
      if (showsHtmlPage && relative === path) return { kind: "html" };
      const info = await hcode.invoke("fs:stat", path);
      if (!info?.exists) {
        const search = workspacePath && relative && relative !== path;
        const paths = search ? await hcode.invoke("fs:listProjectFiles", workspacePath, relative) : [];
        return { kind: "missing", candidates: paths.filter(candidate => candidate.endsWith("/" + relative)) };
      }
      if (info.isDirectory) return { kind: "notice", notice: "这是一个文件夹，请在 Finder 中查看。" };
      if (showsHtmlPage) return { kind: "html" };
      if (imageType) {
        if (info.size > MAX_IMAGE_BYTES) return { kind: "notice", notice: "图片超过 10 MiB 文件预览上限。" };
        if (remoteBridge) return { kind: "remoteImage", url: await remoteBridge.imageUrl(path) };
        const bytes = await hcode.invoke("fs:readMedia", path);
        if (!bytes) return { kind: "notice", notice: "无法读取该图片，请用默认应用打开。" };
        if (!active) return { kind: "notice", notice: "预览已关闭" };
        imageUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: imageType }));
        return { kind: "image", url: imageUrl };
      }
      if (remoteBridge && info.size > FILE_VIEWER_MAX_TEXT_BYTES) {
        return { kind: "paged", page: await remoteBridge.readTextPage(path, 0) };
      }
      if (info.size > FILE_VIEWER_MAX_TEXT_BYTES) return { kind: "notice", notice: canToggleHtml
        ? "HTML 源码超过 256 KiB 高亮上限，请切回「页面」继续预览，或用默认应用查看源码。"
        : "文件超过 256 KiB 预览上限，请用默认应用打开。" };
      const content = await hcode.invoke("fs:readText", path, FILE_VIEWER_MAX_TEXT_BYTES);
      return content === null
        ? { kind: "notice", notice: "该文件为二进制、非 UTF-8 文本或无法读取，请用默认应用打开。" }
        : { kind: "text", content };
    };
    void load().then(
      (value) => { if (active) setResult(value); },
      (error) => { if (active) setResult({ kind: "notice", notice: `读取文件失败：${errorMessage(error)}` }); },
    );
    return () => {
      active = false;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [path, imageType, revision, showsHtmlPage, canToggleHtml, workspacePath, relative]);

  return result;
}
