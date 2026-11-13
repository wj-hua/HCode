// agy 1.5.8 的 stdout 只给步骤终态；从同一原生会话的 JSONL 尾部补取已完成的思考。
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../rowProjectorBase.js";

export const AGY_DATA_DIR = join(homedir(), ".gemini/antigravity-cli");
export const transcriptPath = (id: string) => join(AGY_DATA_DIR, "brain", id, ".system_generated/logs/transcript_full.jsonl");

const BLOCK_BYTES = 64 * 1024;
const RETRY_MS = 250;
const SETTLED_GRACE_MS = 30_000;
type Deliver = (text: string) => void;

/** 仅读到快照的末尾。跨块按字节拼行，避免切坏 UTF-8；忽略仍在写入的末行。 */
async function* reverseLines(path: string) {
  const file = await open(path, "r");
  try {
    let position = (await file.stat()).size;
    let suffix = Buffer.alloc(0);
    let atEnd = true;
    while (position > 0) {
      const length = Math.min(position, BLOCK_BYTES);
      position -= length;
      const { buffer, bytesRead } = await file.read(Buffer.allocUnsafe(length), 0, length, position);
      if (bytesRead !== length) return; // 原生进程截短了文件，下次从新尾部开始。
      const bytes = Buffer.concat([buffer, suffix]);
      let end = atEnd ? bytes.lastIndexOf(10) : bytes.length;
      if (end < 0) continue;
      atEnd = false;
      while (end > 0) {
        const start = bytes.lastIndexOf(10, end - 1) + 1;
        if (start === 0 && position > 0) break;
        if (end > start) yield bytes.toString("utf8", start, end);
        end = start - 1;
      }
      suffix = bytes.subarray(0, Math.max(end, 0));
    }
  } finally {
    await file.close();
  }
}

/** 只按真实的 PLANNER_RESPONSE 终态取值；空 thinking 同样结束该步骤的查询。 */
async function readCompletedSteps(path: string, wanted: Set<number>) {
  const found = new Map<number, string>();
  const earliest = Math.min(...wanted);
  for await (const line of reverseLines(path)) {
    const record: unknown = JSON.parse(line);
    if (!isRecord(record) || typeof record.step_index !== "number") continue;
    if (record.step_index < earliest) break;
    if (!wanted.has(record.step_index) || record.type !== "PLANNER_RESPONSE" || record.status !== "DONE") continue;
    found.set(record.step_index, typeof record.thinking === "string" ? record.thinking.trim() : "");
    if (found.size === wanted.size) break;
  }
  return found;
}

/** 每个会话只并行读一次。迟到结果通过原步骤的回调交付，回合结束仍给落盘留出时间。 */
export class AgyThinkingTranscript {
  private readonly pending = new Map<number, Deliver>();
  private timer?: NodeJS.Timeout;
  private reading = false;
  private endedAt?: number;
  private closed = false;

  constructor(private readonly path: string) {}

  request(index: number, deliver: Deliver) {
    if (this.closed) return;
    this.endedAt = undefined;
    this.pending.set(index, deliver);
    if (!this.reading && !this.timer) void this.refresh();
  }

  endTurn() { this.endedAt = Date.now(); }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.pending.clear();
  }

  private async refresh() {
    this.reading = true;
    this.timer = undefined;
    try {
      const steps = await readCompletedSteps(this.path, new Set(this.pending.keys()));
      for (const [index, text] of steps) {
        if (text) this.pending.get(index)?.(text);
        this.pending.delete(index);
      }
    } catch (error) {
      // ENOENT 是 stdout 先于 transcript 创建的正常竞态。其他读取错误只影响思考补录。
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[agy] 读取实时思考记录失败", error);
        this.pending.clear();
      }
    } finally {
      this.reading = false;
    }
    if (this.endedAt !== undefined && Date.now() - this.endedAt >= SETTLED_GRACE_MS) this.pending.clear();
    if (!this.closed && this.pending.size) this.timer = setTimeout(() => void this.refresh(), RETRY_MS).unref();
  }
}
