/** 生命周期只管理隔离预览地址；项目文件和相对资源由主进程协议提供。 */
import { useEffect, useState } from "react";
import type { HtmlPreviewLease } from "@hcode/shared/htmlPreview";
import { hcode } from "../bridge";

export function HtmlPreviewContent({ path, workspacePath, revision, title }: {
  path: string; workspacePath?: string; revision: number; title: string;
}) {
  const [lease, setLease] = useState<HtmlPreviewLease | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let current: HtmlPreviewLease | undefined;
    const release = (id: string) => {
      void hcode.invoke("fs:releaseHtmlPreview", id).catch(reason => console.error("释放 HTML 预览失败", reason));
    };
    setLease(null);
    setError(null);
    const load = async () => {
      try {
        const result = await hcode.invoke("fs:createHtmlPreview", path, workspacePath);
        if (!active) { release(result.id); return; }
        current = result;
        setLease(result);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void load();
    return () => { active = false; if (current) release(current.id); };
  }, [path, workspacePath, revision]);
  if (error) return <p role="alert" className="p-4 text-ui-sm text-destructive">页面预览失败：{error}</p>;
  if (!lease) return <p role="status" className="p-4 text-ui-sm text-foreground-subtle">正在加载页面…</p>;
  return <iframe title={`${title} 页面预览`} src={lease.url} sandbox="allow-scripts" referrerPolicy="no-referrer" className="block h-full w-full border-0 bg-white" />;
}
