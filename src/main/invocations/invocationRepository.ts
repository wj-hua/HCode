// 每次调用独立原子落盘；应用重启后只恢复记录，活动终态未知时不继续执行。
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentInvocation } from '../../shared/agentInvocation.js';
import { invocationSchema } from './invocationContracts.js';
export class InvocationRepository {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly root: string) {}
  private path(id: string) { return join(this.root, `${z.string().uuid().parse(id)}.json`); }
  async save(call: AgentInvocation) {
    const value = invocationSchema.parse(structuredClone(call));
    const previous = this.writes.get(value.id);
    const write = (async () => {
      if (previous) await previous;
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = join(this.root, `${value.id}-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, this.path(value.id));
    })();
    this.writes.set(value.id, write);
    try { await write; } finally { if (this.writes.get(value.id) === write) this.writes.delete(value.id); }
  }
  async load(id: string): Promise<AgentInvocation> {
    return invocationSchema.parse(JSON.parse(await readFile(this.path(id), 'utf8'))) as AgentInvocation;
  }
  async list() {
    let names: string[];
    try { names = await readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => name.endsWith('.json')).map(name => this.load(name.slice(0, -5))));
  }
}
