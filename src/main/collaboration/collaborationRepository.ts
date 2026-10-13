// 单 Run 串行持久化；事件先落盘，快照原子替换，模型产物单独存储且校验内容 hash。
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CollaborationSnapshot, ReportVersion, SourceEvidence, RecoveryIssue } from "../../shared/collaboration.js";
import { snapshotSchema, reportSchema, reportMarkdown } from "./contracts.js";

function digest(text: string) { return createHash("sha256").update(text).digest("hex"); }

function replay(id: string, events: string): CollaborationSnapshot {
  let latest: CollaborationSnapshot | undefined;
  for (const line of events.trimEnd().split("\n")) {
    const next = snapshotSchema.parse(JSON.parse(line));
    if (next.id !== id || next.seq !== (latest?.seq ?? 0) + 1) throw new Error(`协作 ${id} 的事件序号不连续`);
    latest = next;
  }
  if (!latest) throw new Error("协作记录没有有效事件");
  return latest;
}

/** 只允许截去不能解析且未以换行提交的尾部；完整前缀必须全部通过校验。 */
function repairablePrefix(id: string, events: string) {
  if (events.endsWith("\n")) throw new Error("事件不是半截尾行，不能自动修复");
  const boundary = events.lastIndexOf("\n");
  if (boundary < 0) throw new Error("没有已提交事件可恢复");
  let incomplete = false;
  try { JSON.parse(events.slice(boundary + 1)); }
  catch (error) { if (error instanceof SyntaxError) incomplete = true; else throw error; }
  if (!incomplete) throw new Error("尾行内容完整但缺少提交分隔，需人工核对");
  const prefix = events.slice(0, boundary + 1);
  return { prefix, snapshot: replay(id, prefix) };
}

export class CollaborationRepository {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(readonly root: string) {}

  private directory(id: string) { return join(this.root, z.string().uuid().parse(id)); }

  /** 复制提交时的值，避免排队落盘期间状态继续变化造成 seq/内容错位。 */
  async save(snapshot: CollaborationSnapshot): Promise<void> {
    const value = snapshotSchema.parse(structuredClone(snapshot));
    const previous = this.writes.get(value.id);
    const write = (async () => {
      if (previous) await previous;
      const directory = this.directory(value.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const json = JSON.stringify(value);
      await appendFile(join(directory, "events.jsonl"), `${json}\n`, { mode: 0o600 });
      const temporary = join(directory, `run-${randomUUID()}.tmp`);
      await writeFile(temporary, json, { mode: 0o600 });
      await rename(temporary, join(directory, "run.json"));
    })();
    this.writes.set(value.id, write);
    try { await write; }
    finally { if (this.writes.get(value.id) === write) this.writes.delete(value.id); }
  }

  /** 回放完整事件；损坏/跳号显式失败，不把半截记录解释成空 Run。 */
  async load(id: string): Promise<CollaborationSnapshot> {
    const events = await readFile(join(this.directory(id), "events.jsonl"), "utf8");
    if (!events.endsWith("\n")) throw new Error(`协作 ${id} 的事件尾行不完整，需要人工恢复`);
    return replay(id, events);
  }

  async list(): Promise<CollaborationSnapshot[]> {
    const catalog = await this.catalog();
    if (catalog.issues.length) throw new Error(catalog.issues.map((issue) => issue.error).join("\n"));
    return catalog.snapshots;
  }

  /** 坏记录单列并返回错误；不能阻止健康 Run 的展示，也不能静默当作空记录。 */
  async catalog(): Promise<{ snapshots: CollaborationSnapshot[]; issues: RecoveryIssue[] }> {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { snapshots: [], issues: [] }; throw error; }
    const snapshots: CollaborationSnapshot[] = [];
    const issues: RecoveryIssue[] = [];
    for (const entry of entries.filter((entry) => entry.isDirectory())) {
      try { snapshots.push(await this.load(entry.name)); }
      catch (error) {
        let canRepairTail = false;
        let repairError = "";
        try { repairablePrefix(entry.name, await readFile(join(this.directory(entry.name), "events.jsonl"), "utf8")); canRepairTail = true; }
        catch (recoveryError) { repairError = `；自动恢复不可用：${String(recoveryError)}`; }
        issues.push({ runId: entry.name, error: `${String(error)}${repairError}`, canRepairTail });
      }
    }
    return { snapshots: snapshots.sort((left, right) => right.createdAt - left.createdAt), issues };
  }

  /** 用户显式请求后备份完整坏日志，原子替换前缀；任何模型回合都不会因此自动执行。 */
  async repairTail(id: string) {
    if (this.writes.has(id)) throw new Error("记录正在写入，不能恢复");
    const directory = this.directory(id);
    const events = await readFile(join(directory, "events.jsonl"), "utf8");
    const { prefix, snapshot } = repairablePrefix(id, events);
    await writeFile(join(directory, `events-damaged-${randomUUID()}.jsonl`), events, { mode: 0o600, flag: "wx" });
    const temporary = join(directory, `events-${randomUUID()}.tmp`);
    await writeFile(temporary, prefix, { mode: 0o600 });
    await rename(temporary, join(directory, "events.jsonl"));
    const snapshotTemporary = join(directory, `run-${randomUUID()}.tmp`);
    await writeFile(snapshotTemporary, JSON.stringify(snapshot), { mode: 0o600 });
    await rename(snapshotTemporary, join(directory, "run.json"));
    return snapshot;
  }

  async writeReport(runId: string, version: number, text: string, evidence: SourceEvidence[]): Promise<ReportVersion> {
    const report = reportSchema.parse(JSON.parse(text));
    const content = JSON.stringify(report);
    const id = randomUUID();
    const directory = join(this.directory(runId), "artifacts");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, `${id}.json`), content, { mode: 0o600, flag: "wx" });
    return { id, version, hash: digest(content), summary: report.summary, evidence };
  }

  async readReport(runId: string, version: ReportVersion) {
    const path = join(this.directory(runId), "artifacts", `${z.string().uuid().parse(version.id)}.json`);
    const text = await readFile(path, "utf8");
    if (digest(text) !== version.hash) throw new Error("报告文件已变化，原审查结果失效");
    const report = reportSchema.parse(JSON.parse(text));
    return { text, markdown: reportMarkdown(report), report };
  }
}
