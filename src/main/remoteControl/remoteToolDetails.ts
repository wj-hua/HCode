// 历史工具只传摘要；详情按签名来源重新读取，不额外保存工具正文或运行记录。
import { createHash } from "node:crypto";
import type { ConversationRow } from "../../shared/types.js";
import type { RemoteRowSource, RemoteToolRow } from "../../shared/remoteControl.js";
import { changesFromRows } from "../../shared/conversationChanges.js";
import { RemoteReferenceNotFound, SignedReference } from "./signedReference.js";

type ToolRow = Extract<ConversationRow, { kind: "toolCall" }>;
interface ToolReference { source: RemoteRowSource; rowId: number; toolCallId: string; digest: string }
const ERROR_SUMMARY_LENGTH = 200;
const FINISHED_TOOL_STATUSES = new Set<ToolRow["status"]>(["success", "error", "cancelled"]);

export class RemoteToolDetails {
  private readonly references = new SignedReference();
  constructor(private readonly readRows: (source: RemoteRowSource) => Promise<readonly ConversationRow[]>) {}

  /** 审批和正在运行的工具保留实时输入；已结束的记录仅保留状态、身份与文件统计。 */
  mapRow(row: ConversationRow, source: RemoteRowSource): ConversationRow {
    if (row.kind !== "toolCall" || !FINISHED_TOOL_STATUSES.has(row.status)) return row;
    const { inputText: _inputText, input: _input, output: _output, display: _display, progress: _progress, outputPreview: _preview, error, ...summary } = row;
    const ref = this.references.encode<ToolReference>({ source, rowId: row.rowId, toolCallId: row.toolCallId, digest: digest(row) });
    const result: RemoteToolRow = { ...summary, inputText: "", ...(error ? { error: { ...error, message: error.message.slice(0, ERROR_SUMMARY_LENGTH) } } : {}), remoteDetails: {
      ref, changes: changesFromRows([row]).map(({ path, additions, deletions, patches }) => ({ path, additions, deletions, hasPatch: patches.length > 0 })),
    } };
    return result;
  }

  /** 展开时重验来源与正文；失效引用明确报错，由客户端刷新会话后重试。 */
  async read(reference: string): Promise<ToolRow> {
    const ref = this.references.decode<ToolReference>(reference);
    const rows = await this.readRows(ref.source);
    const row = rows.find(candidate => candidate.rowId === ref.rowId);
    if (row?.kind !== "toolCall" || row.toolCallId !== ref.toolCallId || digest(row) !== ref.digest) throw new RemoteReferenceNotFound();
    return row;
  }
}

function digest(row: ToolRow): string { return createHash("sha256").update(JSON.stringify([row.toolName, row.status, row.inputText, row.input, row.output, row.display, row.error])).digest("base64url"); }
