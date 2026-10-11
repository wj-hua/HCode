// 使用真实元数据文件核验原生工具目录，旧线程不能靠 thread/resume 的成功响应补工具。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AppServerClient } from '../appServerClient.js';
import { assertToolCatalog, readToolCatalog, sourceCatalogReason } from '../toolCatalog.js';
import { codexResearchTools } from '../researchTools.js';
import { COLLABORATION_SOURCE_TOOL_NAMES } from '../../../../shared/collaboration.js';
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('恢复匹配的原生目录，缺工具/参数契约变化不能悄悄换线程', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hcode-catalog-')); roots.push(root); vi.stubEnv('CODEX_HOME', root);
  const path = join(root, 'rollout.jsonl'), runtime = { root, tools: COLLABORATION_SOURCE_TOOL_NAMES.map((name) => ({ name, description: name, schema: { taskId: z.string() }, execute: async () => ({}) })) };
  const tools = codexResearchTools(runtime);
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: 'thread', dynamic_tools: tools } }) + '\n');
  const client = { call: async () => ({ thread: { id: 'thread', path } }) } as unknown as AppServerClient;
  const catalog = await readToolCatalog(client, 'thread');
  expect(sourceCatalogReason(catalog)).toBeUndefined();
  expect(() => assertToolCatalog(catalog, runtime)).not.toThrow();
  expect(sourceCatalogReason(catalog.filter((tool) => tool.name !== 'hcode_delegate_task'))).toMatch(/不能给已有线程补工具/);
  const changed = structuredClone(catalog); changed[0]!.inputSchema = {};
  expect(() => assertToolCatalog(changed, runtime)).toThrow(/匹配工具/);
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: 'different', dynamic_tools: tools } }) + '\n');
  await expect(readToolCatalog(client, 'thread')).rejects.toThrow();
});
