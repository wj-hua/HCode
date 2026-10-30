// 普通宿主工具按本机 CLI 的协议检测，不以版本号代替能力；研究沙箱的版本准入由调用方独立执行。
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 15_000;
const schemaShape = z.object({ properties: z.record(z.string(), z.unknown()) });
const propertyShape = z.object({ type: z.union([z.string(), z.array(z.string())]) });
export type CodexHostedProtocol = { supported: true } | { supported: false; reason: string };

function properties(schema: unknown, method: string, names: readonly string[]) {
  const parsed = schemaShape.parse(schema).properties;
  const missing = names.filter(name => !Object.hasOwn(parsed, name));
  if (missing.length) throw new Error(`CLI 协议缺少 ${method}.${missing.join('、')}`);
  return parsed;
}

function requireType(property: unknown, name: string, expected: string) {
  const { type } = propertyShape.parse(property);
  if (type !== expected && !(Array.isArray(type) && type.includes(expected))) throw new Error(`CLI 协议 ${name} 不支持 ${expected} 类型`);
}

/** 生成与当前可执行文件匹配的协议；不启动模型、不创建线程、不写 CLI 配置，临时文件始终清理。 */
export async function probeCodexHostedProtocol(executable: string, env: NodeJS.ProcessEnv): Promise<CodexHostedProtocol> {
  const directory = await mkdtemp(join(tmpdir(), 'hcode-codex-protocol-'));
  try {
    await execFileAsync(executable, ['app-server', 'generate-json-schema', '--experimental', '--out', directory], { env, timeout: PROBE_TIMEOUT_MS });
    const schemas = await Promise.all([
      'v2/ThreadStartParams.json', 'v2/ThreadInjectItemsParams.json',
      'DynamicToolCallParams.json', 'DynamicToolCallResponse.json',
    ].map(async path => JSON.parse(await readFile(join(directory, path), 'utf8')) as unknown));
    const start = properties(schemas[0], 'thread/start', ['dynamicTools']);
    requireType(start.dynamicTools, 'thread/start.dynamicTools', 'array');
    const injection = properties(schemas[1], 'thread/inject_items', ['threadId', 'items']);
    requireType(injection.threadId, 'thread/inject_items.threadId', 'string');
    requireType(injection.items, 'thread/inject_items.items', 'array');
    properties(schemas[2], 'item/tool/call', ['threadId', 'turnId', 'callId', 'tool', 'arguments']);
    const response = properties(schemas[3], 'item/tool/call response', ['success', 'contentItems']);
    requireType(response.success, 'item/tool/call response.success', 'boolean');
    requireType(response.contentItems, 'item/tool/call response.contentItems', 'array');
    return { supported: true };
  } catch (error) {
    // 老 CLI 缺少生成器、协议变化和进程失败均可观测；普通聊天可继续，申请宿主工具的回合必须报告此原因。
    return { supported: false, reason: `Codex 宿主工具协议检测失败：${error instanceof Error ? error.message : String(error)}` };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
