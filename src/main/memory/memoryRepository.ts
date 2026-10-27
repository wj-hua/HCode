import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { memoryEntrySchema, type MemoryEntry } from '../../shared/memory.js';

/** 每条独立原子写入；删除与保存共用同一条目的写入队列。 */
export class MemoryRepository {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly root: string) {}
  private path(id: string) { return join(this.root, `${z.string().uuid().parse(id)}.json`); }
  private async mutate(id: string, action: () => Promise<void>) {
    this.path(id);
    const previous = this.writes.get(id);
    const write = (async () => { await previous?.catch(() => {}); await action(); })();
    this.writes.set(id, write);
    try { await write; } finally { if (this.writes.get(id) === write) this.writes.delete(id); }
  }
  async save(entry: MemoryEntry) {
    const value = memoryEntrySchema.parse(entry);
    await this.mutate(value.id, async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = join(this.root, `${value.id}-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.path(value.id));
      } finally { await rm(temporary, { force: true }); }
    });
  }
  async delete(id: string) { await this.mutate(id, () => rm(this.path(id))); }
  async list(): Promise<MemoryEntry[]> {
    let names: string[];
    try { names = await readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => name.endsWith('.json')).map(async name =>
      memoryEntrySchema.parse(JSON.parse(await readFile(this.path(name.slice(0, -5)), 'utf8')))));
  }
}
