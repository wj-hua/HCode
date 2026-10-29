// 会话文件变更投影：桌面原始工具与远程摘要共用统计规则，差异正文按需读取。
import type { ConversationRow } from "./types.js";
import { isRemoteToolRow } from "./remoteControl.js";

export type Change = { path: string; patches: string[]; additions: number; deletions: number; detailRefs?: string[] };
export function changesFromRows(rows: readonly ConversationRow[]): Change[] {
  const files = new Map<string, Change>();
  for (const row of rows) {
    if (isRemoteToolRow(row)) {
      for (const change of row.remoteDetails.changes) {
        const file = files.get(change.path) ?? { path: change.path, patches: [], additions: 0, deletions: 0, detailRefs: [] };
        file.additions += change.additions; file.deletions += change.deletions;
        if (change.hasPatch) file.detailRefs = [...(file.detailRefs ?? []), row.remoteDetails.ref];
        files.set(change.path, file);
      }
      continue;
    }
    if (row.kind !== "toolCall" || row.status !== "success" || !row.input || typeof row.input !== "object") continue;
    if (row.toolName === "Edit" || row.toolName === "MultiEdit") {
      const input = row.input as { file_path?: unknown; old_string?: unknown; new_string?: unknown; edits?: unknown };
      const edits = row.toolName === "MultiEdit" && Array.isArray(input.edits) ? input.edits : [input];
      const changed = edits.some((edit: unknown) => {
        if (!edit || typeof edit !== "object") return false;
        const { old_string, new_string } = edit as { old_string?: unknown; new_string?: unknown };
        return typeof old_string === "string" && typeof new_string === "string" && old_string !== new_string;
      });
      // 没有工具结果的“成功”可能只是会话投影推断的完成状态。
      if (row.output && changed && typeof input.file_path === "string" && input.file_path && !files.has(input.file_path)) {
        files.set(input.file_path, { path: input.file_path, patches: [], additions: 0, deletions: 0 });
      }
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
      if ((!diff && item.type !== "add" && item.type !== "delete") || (hasHunk && !lines.some(line => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))))) continue;
      const additions = hasHunk ? lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length : item.type === "delete" ? 0 : lines.length;
      const deletions = hasHunk ? lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length : item.type === "delete" ? lines.length : 0;
      const file = files.get(path) ?? { path, patches: [], additions: 0, deletions: 0 };
      const patch = hasHunk ? diff : `@@ -${item.type === "delete" ? `1,${lines.length}` : "0,0"} +${item.type === "delete" ? "0,0" : `1,${lines.length}`} @@\n${lines.map(line => `${item.type === "delete" ? "-" : "+"}${line}`).join("\n")}`;
      file.patches.push(patch); file.additions += additions; file.deletions += deletions; files.set(path, file);
    }
  }
  return [...files.values()];
}

