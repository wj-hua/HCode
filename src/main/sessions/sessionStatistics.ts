// 每个原生会话保存独立计时样本；重开、分页、重启均不依赖当前消息窗口。
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ChatUsage, SessionRef, SessionStatistics } from "../../shared/types.js";

const number = z.number().finite().nonnegative();
const sampleSchema = z.object({
  turnStatistics: z.object({ id: z.string().min(1), toolCalls: number.int(), toolMs: number,
    incompleteTools: number.int(), responseMs: number.optional() }),
  inputTokens: number.optional(), outputTokens: number.optional(), ttftMs: number.optional(),
  outputTokensPerSecond: number.optional(), outputSpeedDurationMs: number.optional(),
  outputSpeedBasis: z.enum(["activeTurn", "response"]).optional(),
});
type Sample = z.infer<typeof sampleSchema>;
const fileSchema = z.object({ version: z.literal(1), samples: z.array(sampleSchema) });

function summarize(samples: Iterable<Sample>): SessionStatistics {
  const totals: SessionStatistics = { turns: 0, inputTokens: 0, outputTokens: 0, usageTurns: 0,
    responseMs: 0, responseTurns: 0, toolCalls: 0, toolMs: 0, incompleteTools: 0,
    ttftMs: 0, ttftTurns: 0, activeTurnTokens: 0, activeTurnMs: 0, responseTokens: 0, responseSpeedMs: 0 };
  for (const sample of samples) {
    totals.turns++;
    totals.toolCalls += sample.turnStatistics.toolCalls;
    totals.toolMs += sample.turnStatistics.toolMs;
    totals.incompleteTools += sample.turnStatistics.incompleteTools;
    if (sample.turnStatistics.responseMs !== undefined) {
      totals.responseMs += sample.turnStatistics.responseMs;
      totals.responseTurns++;
    }
    if (sample.inputTokens !== undefined && sample.outputTokens !== undefined) {
      totals.inputTokens += sample.inputTokens;
      totals.outputTokens += sample.outputTokens;
      totals.usageTurns++;
    }
    if (sample.ttftMs !== undefined) { totals.ttftMs += sample.ttftMs; totals.ttftTurns++; }
    // 只汇总用量与时间配对的样本；累计吞吐不能平均各轮的速度。
    if (sample.outputTokensPerSecond !== undefined && sample.outputSpeedDurationMs !== undefined &&
      sample.outputSpeedDurationMs > 0 && sample.outputTokens !== undefined) {
      if (sample.outputSpeedBasis === "activeTurn") {
        totals.activeTurnMs += sample.outputSpeedDurationMs;
        totals.activeTurnTokens += sample.outputTokens;
      } else if (sample.outputSpeedBasis === "response") {
        totals.responseSpeedMs += sample.outputSpeedDurationMs;
        totals.responseTokens += sample.outputTokens;
      }
    }
  }
  return totals;
}

interface Entry { samples: Map<string, Sample>; usage?: ChatUsage }
export class SessionStatisticsStore {
  private readonly cache = new Map<string, Entry>();
  constructor(private readonly directory: string) {}

  private path(ref: SessionRef) {
    const key = createHash("sha256").update(JSON.stringify([ref.agent, ref.projectPath, ref.id])).digest("hex");
    return join(this.directory, `${key}.json`);
  }

  private load(ref: SessionRef): Entry {
    const path = this.path(ref);
    const cached = this.cache.get(path);
    if (cached) return cached;
    let samples: Sample[];
    try { samples = fileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).samples; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      samples = [];
    }
    const entry: Entry = { samples: new Map(samples.map(sample => [sample.turnStatistics.id, sample])) };
    this.updateUsage(entry);
    this.cache.set(path, entry);
    return entry;
  }

  private updateUsage(entry: Entry) {
    const last = [...entry.samples.values()].at(-1);
    if (!last) return;
    const { turnStatistics: _, ...usage } = last;
    entry.usage = { ...usage, sessionStatistics: summarize(entry.samples.values()) };
  }

  usage(ref: SessionRef): ChatUsage | undefined { return this.load(ref).usage; }

  record(ref: SessionRef, usage: ChatUsage): ChatUsage | undefined {
    const entry = this.load(ref);
    if (!usage.turnStatistics) return entry.usage;
    const sample = sampleSchema.parse(usage);
    const id = sample.turnStatistics.id;
    if (JSON.stringify(entry.samples.get(id)) === JSON.stringify(sample)) return entry.usage;
    const next = new Map(entry.samples);
    next.set(id, sample);
    mkdirSync(this.directory, { recursive: true });
    const path = this.path(ref);
    writeFileSync(`${path}.tmp`, JSON.stringify({ version: 1, samples: [...next.values()] }));
    renameSync(`${path}.tmp`, path);
    entry.samples = next;
    this.updateUsage(entry);
    return entry.usage;
  }

  delete(ref: SessionRef) {
    const path = this.path(ref);
    rmSync(path, { force: true });
    this.cache.delete(path);
  }
}
