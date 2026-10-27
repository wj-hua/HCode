// 动态工具属于原生线程的创建元数据；恢复只能核验，不能把 resume 成功当作补工具成功。
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { COLLABORATION_SOURCE_TOOL_NAMES } from '../../../shared/collaboration.js';
import type { AppServerClient } from './appServerClient.js';
import { codexResearchTools } from './researchTools.js';
import { researchPath, type ResearchRuntime } from '../../sessions/researchRuntime.js';
const MAX_METADATA_BYTES = 512 * 1024;
export type CodexToolSpec = ReturnType<typeof codexResearchTools>[number] & { namespace?: string | null };
const toolSchema = z.object({ name: z.string(), type: z.literal('function').optional(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()), namespace: z.string().nullable().optional() });
export const MISSING_SOURCE_TOOLS = '该 Codex 线程没有 HCode 委派工具，本机版本不能给已有线程补工具。请在新建 Codex 会话发送普通消息之前启动协作；原线程与历史保持原样。';
/** 只读服务端返回的线程元数据文件，校验存储范围、原生身份及目录完整性。 */
export async function readToolCatalog(client: AppServerClient, threadId: string) {
  const { thread } = await client.call<{ thread: { id: string; path: string | null } }>('thread/read', { threadId, includeTurns: false });
  if (thread.id !== threadId || !thread.path) throw new Error('Codex 未提供可核验的原生线程元数据');
  const path = await realpath(thread.path), root = await realpath(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  await researchPath(root, path);
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_METADATA_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(10);
    if (newline < 0) throw new Error('Codex 线程创建元数据不完整或超过大小限制');
    const metadata = z.object({ type: z.literal('session_meta'), payload: z.object({ id: z.literal(threadId), dynamic_tools: z.array(toolSchema).nullable().optional() }) }).parse(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
    return metadata.payload.dynamic_tools ?? [];
  } finally { await file.close(); }
}
export function sourceCatalogReason(catalog: readonly { name: string }[]) {
  return COLLABORATION_SOURCE_TOOL_NAMES.every((name) => catalog.some((tool) => tool.name === `hcode_${name}`)) ? undefined : MISSING_SOURCE_TOOLS;
}
/** 参数 schema 和描述也必须匹配，防止旧工具目录被绑定到另一套宿主语义。 */
export function assertToolCatalog(catalog: readonly z.infer<typeof toolSchema>[], runtime: ResearchRuntime) {
  for (const expected of codexResearchTools(runtime)) {
    const actual = catalog.find((tool) => tool.name === expected.name && tool.namespace == null);
    if (!actual || actual.description !== expected.description || !isDeepStrictEqual(actual.inputSchema, expected.inputSchema)) throw new Error(`Codex 恢复线程缺少匹配工具 ${expected.name}；不能补工具或替换线程，请使用匹配的协作线程`);
  }
}
