// 文件摘要直接展示统计；审查操作才读取工具差异，读取失败保留摘要并可重试。
import { useMemo, useState } from "react";
import { ChevronDownIcon, FileCodeIcon } from "lucide-react";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { useFilePreview } from "./FilePreviewContext";
import { remoteBridge } from "../bridge";
import { changesFromRows, type Change } from "@hcode/shared/conversationChanges";
export { changesFromRows } from "@hcode/shared/conversationChanges";

function ChangedFile({ file }: { file: Change }) {
  const preview = useFilePreview();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const hasPatch = file.patches.length > 0 || !!file.detailRefs?.length;
  async function review() {
    if (loading || !preview) return;
    setLoading(true); setError(undefined);
    try {
      const bridge = remoteBridge;
      const details = file.detailRefs?.length && bridge ? await Promise.all([...new Set(file.detailRefs)].map(ref => bridge.loadToolDetails(ref))) : [];
      const patches = [...file.patches, ...changesFromRows(details).filter(change => change.path === file.path).flatMap(change => change.patches)];
      if (!patches.length) throw new Error("当前工具没有可审查的差异，请刷新会话");
      preview.onOpenCodeViewer({ type: "patch", title: file.path.split("/").at(-1) ?? file.path, path: file.path, patch: patches.join("\n") });
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setLoading(false); }
  }
  return <div>
    <div className="flex items-center gap-2 px-3 py-2">
      <FileCodeIcon className="size-4 shrink-0 text-green-500" /><span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>
      {hasPatch ? <><span className="shrink-0 text-green-500">+{file.additions}</span><span className="shrink-0 text-red-500">−{file.deletions}</span><button type="button" aria-busy={loading} disabled={loading} className="shrink-0 whitespace-nowrap rounded border border-border px-2 py-1 hover:bg-muted pointer-coarse:min-h-11" onClick={() => void review()}>{loading ? "加载中…" : error ? "重试审查" : "审查"}</button></> : <span className="shrink-0 text-ui-sm text-foreground-subtlest">无差异记录</span>}
      <button type="button" className="shrink-0 whitespace-nowrap rounded border border-border px-2 py-1 hover:bg-muted pointer-coarse:min-h-11" onClick={() => preview?.onOpenFilePath(file.path)}>打开</button>
    </div>
    {error ? <p role="alert" className="px-3 pb-2 text-ui-sm text-destructive">{error}</p> : null}
  </div>;
}
export function TurnChangeSummary({ rows }: { rows: readonly ConversationRow[] }) {
  const files = useMemo(() => changesFromRows(rows), [rows]);
  const [open, setOpen] = useState(true);
  if (!files.length) return null;
  const additions = files.reduce((count, file) => count + file.additions, 0), deletions = files.reduce((count, file) => count + file.deletions, 0);
  return <div className="overflow-hidden rounded-xl border border-border bg-muted/30 text-ui-base">
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left"><ChevronDownIcon className={`size-4 ${open ? "" : "-rotate-90"}`} /><span>{files.length} 个文件已更改</span><span className="text-green-500">+{additions}</span><span className="text-red-500">−{deletions}</span></button>
    {open ? <div className="border-t border-border">{files.map(file => <ChangedFile key={file.path} file={file} />)}<p className="px-3 pb-2 text-ui-sm text-foreground-subtlest">根据工具记录统计，并非文件当前状态；无法确认内容变化的写入未列出。同一文件多次修改的行数为各次之和，缺少差异的文件未计入行数。</p></div> : null}
  </div>;
}
