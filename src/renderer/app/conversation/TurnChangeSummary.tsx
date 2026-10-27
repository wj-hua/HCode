import { useMemo, useState } from "react";
import { ChevronDownIcon, FileCodeIcon } from "lucide-react";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { useFilePreview } from "./FilePreviewContext";

type Change = { path: string; patches: string[]; additions: number; deletions: number };
export function changesFromRows(rows: readonly ConversationRow[]): Change[] {
  const files = new Map<string, Change>();
  for (const row of rows) {
    if (row.kind !== "toolCall" || row.status !== "success" || !row.input || typeof row.input !== "object") continue;
    if (["Edit", "Write", "MultiEdit"].includes(row.toolName)) {
      const path = (row.input as { file_path?: unknown }).file_path;
      if (typeof path === "string" && path && !files.has(path)) files.set(path, { path, patches: [], additions: 0, deletions: 0 });
      continue;
    }
    if (row.toolName !== "ApplyPatch") continue;
    const changes = (row.input as { changes?: unknown }).changes;
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) continue;
    for (const [path, value] of Object.entries(changes)) {
      if (!value || typeof value !== "object") continue;
      const item = value as { unified_diff?: unknown; type?: unknown };
      if (typeof item.unified_diff !== "string" || !path) continue;
      const diff = item.unified_diff;
      const lines = diff.replace(/\r\n/g, "\n").split("\n");
      if (lines.at(-1) === "") lines.pop();
      const hasHunk = diff.includes("@@");
      const additions = hasHunk ? lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length : item.type === "delete" ? 0 : lines.length;
      const deletions = hasHunk ? lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length : item.type === "delete" ? lines.length : 0;
      const file = files.get(path) ?? { path, patches: [], additions: 0, deletions: 0 };
      const patch = hasHunk ? diff : `@@ -${item.type === "delete" ? `1,${lines.length}` : "0,0"} +${item.type === "delete" ? "0,0" : `1,${lines.length}`} @@\n${lines.map(line => `${item.type === "delete" ? "-" : "+"}${line}`).join("\n")}`;
      file.patches.push(patch); file.additions += additions; file.deletions += deletions; files.set(path, file);
    }
  }
  return [...files.values()];
}

export function TurnChangeSummary({ rows }: { rows: readonly ConversationRow[] }) {
  const files = useMemo(() => changesFromRows(rows), [rows]);
  const [open, setOpen] = useState(true);
  const preview = useFilePreview();
  if (!files.length) return null;
  const additions = files.reduce((n, f) => n + f.additions, 0), deletions = files.reduce((n, f) => n + f.deletions, 0);
  return <div className="overflow-hidden rounded-xl border border-border bg-muted/30 text-ui-base">
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left"><ChevronDownIcon className={`size-4 ${open ? "" : "-rotate-90"}`} /><span>{files.length} 个文件已更改</span><span className="text-green-500">+{additions}</span><span className="text-red-500">−{deletions}</span></button>
    {open ? <div className="border-t border-border">{files.map(file => <div key={file.path} className="flex items-center gap-2 px-3 py-2"><FileCodeIcon className="size-4 shrink-0 text-green-500" /><span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>{file.patches.length ? <><span className="text-green-500">+{file.additions}</span><span className="text-red-500">−{file.deletions}</span><button type="button" className="rounded border border-border px-2 py-1 hover:bg-muted" onClick={() => preview?.onOpenCodeViewer({ type: "patch", title: file.path.split("/").at(-1) ?? file.path, path: file.path, patch: file.patches.join("\n") })}>审查</button></> : <span className="text-ui-sm text-foreground-subtlest">无差异记录</span>}<button type="button" className="rounded border border-border px-2 py-1 hover:bg-muted" onClick={() => preview?.onOpenFilePath(file.path)}>打开</button></div>)}<p className="px-3 pb-2 text-ui-sm text-foreground-subtlest">根据工具记录统计；同一文件多次修改的行数为各次之和，缺少差异的文件未计入行数。</p></div> : null}
  </div>;
}
