// 独立恢复日志先于原项目副作用落盘；同步文件与目录，重启只读，不自动续写。
import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hashBytes } from "../workspaces/fileManifest.js";
import {
  adoptionJournalSchema,
  type AdoptionJournal,
} from "./adoptionContracts.js";
export async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function durableFile(
  path: string,
  bytes: string | Buffer,
  mode = 0o600,
) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export class AdoptionJournalRepository {
  constructor(private readonly storage: string) {}
  directory(runId: string, id: string) {
    return join(
      this.storage,
      z.string().uuid().parse(runId),
      "adoptions",
      z.string().uuid().parse(id),
    );
  }
  /** 冻结恢复字节和首个日志；失败时不启动原项目替换。 */
  async create(journal: AdoptionJournal, contents: Map<string, Buffer>) {
    const directory = this.directory(journal.state.runId, journal.state.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [index, operation] of journal.operations.entries()) {
      for (const side of ["before", "after"] as const) {
        const bytes = contents.get(`${side}:${operation.path}`);
        if (bytes)
          await durableFile(join(directory, `${index}-${side}`), bytes);
      }
    }
    await this.save(journal);
    await syncDirectory(dirname(directory));
  }
  /** 校验并同步原子日志；IO 失败向调用方传播，不能标记成功。 */
  async save(journal: AdoptionJournal) {
    const value = adoptionJournalSchema.parse(journal);
    value.state.updatedAt = Date.now();
    journal.state.updatedAt = value.state.updatedAt;
    const json = JSON.stringify(value),
      directory = this.directory(value.state.runId, value.state.id);
    const temporary = join(directory, `${randomUUID()}.tmp`);
    await durableFile(
      temporary,
      JSON.stringify({ hash: hashBytes(json), journal: value }),
    );
    await rename(temporary, join(directory, "journal.json"));
    await syncDirectory(directory);
  }
  /** 核对 Run/id 与完整性；损坏日志不能解释成尚未应用。 */
  async load(runId: string, id: string): Promise<AdoptionJournal> {
    const stored = JSON.parse(
      await readFile(join(this.directory(runId, id), "journal.json"), "utf8"),
    );
    if (hashBytes(JSON.stringify(stored.journal)) !== stored.hash)
      throw new Error("采纳恢复日志 hash 已变化");
    const journal = adoptionJournalSchema.parse(stored.journal);
    if (journal.state.runId !== runId || journal.state.id !== id)
      throw new Error("采纳日志不属于此 Run");
    return journal;
  }
  /** 查找此 Run 最新记录；只在目录不存在时返回无记录。 */
  async latest(runId: string) {
    const root = join(
      this.storage,
      z.string().uuid().parse(runId),
      "adoptions",
    );
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const journals = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map((e) => this.load(runId, e.name)),
    );
    return journals.sort(
      (left, right) => right.state.createdAt - left.state.createdAt,
    )[0];
  }
  /** 返回匹配冻结 hash 的恢复字节，缺失或污染明确失败。 */
  async content(
    journal: AdoptionJournal,
    index: number,
    side: "before" | "after",
  ) {
    const expected = journal.operations[index]![side];
    if (!expected) throw new Error("恢复内容没有配对清单");
    const bytes = await readFile(
      join(
        this.directory(journal.state.runId, journal.state.id),
        `${index}-${side}`,
      ),
    );
    if (hashBytes(bytes) !== expected.hash)
      throw new Error(`恢复内容 hash 已变化：${expected.path}`);
    return bytes;
  }
}
