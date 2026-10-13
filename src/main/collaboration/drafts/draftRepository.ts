// 草案独立持久化；原子替换与 UUID 路径校验，损坏记录显式报错。
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ResearchDraft } from "../../../shared/researchDraft.js";
import type { PlanningDraft } from "../../../shared/planningDraft.js";

export class DraftRepository<T extends PlanningDraft = ResearchDraft> {
  constructor(readonly root: string, private readonly schema: z.ZodType<T>) {}
  private path(id: string) { return join(this.root, `${z.string().uuid().parse(id)}.json`); }
  async save(draft: T) {
    const value = this.schema.parse(draft);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `${value.id}-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temporary, this.path(value.id));
  }
  async load(id: string): Promise<T> {
    const value = this.schema.parse(JSON.parse(await readFile(this.path(id), "utf8")));
    if (value.id !== id) throw new Error("草案身份与文件不一致");
    return value;
  }
  async list() {
    let names: string[];
    try { names = await readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return Promise.all(names.filter(name => name.endsWith(".json")).map(name => this.load(name.slice(0, -5))));
  }
}
