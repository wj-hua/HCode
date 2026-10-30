// 通过真实子进程边界验证能力检测；替身 CLI 只生成协议文件，不启动模型或修改用户配置。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { probeCodexHostedProtocol } from '../hostedProtocol.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(unsupported?: 'registration' | 'injection' | 'result' | 'command') {
  const root = await mkdtemp(join(tmpdir(), 'hcode-hosted-protocol-'));
  roots.push(root);
  const executable = join(root, 'codex');
  const schemas = {
    'v2/ThreadStartParams.json': { properties: unsupported === 'registration' ? {} : { dynamicTools: { type: ['array', 'null'] } } },
    'v2/ThreadInjectItemsParams.json': { properties: unsupported === 'injection' ? {} : { threadId: { type: 'string' }, items: { type: 'array' } } },
    'DynamicToolCallParams.json': { properties: { threadId: {}, turnId: {}, callId: {}, tool: {}, arguments: {} } },
    'DynamicToolCallResponse.json': { properties: { contentItems: { type: 'array' }, success: { type: unsupported === 'result' ? 'string' : 'boolean' } } },
  };
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (${unsupported === 'command'}) { console.error('unknown command generate-json-schema'); process.exit(2); }
const output = process.argv[process.argv.indexOf('--out') + 1];
for (const [name, schema] of Object.entries(${JSON.stringify(schemas)})) {
  const file = path.join(output, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(schema));
}
`, { mode: 0o755 });
  return executable;
}

it('根据当前 CLI 协议启用普通宿主工具，不依赖版本号', async () => {
  expect(await probeCodexHostedProtocol(await fixture(), process.env)).toEqual({ supported: true });
});

it.each([
  ['registration', 'dynamicTools'], ['injection', 'thread/inject_items'], ['result', 'success'],
] as const)('缺少 %s 能力时返回具体限制', async (unsupported, reason) => {
  expect(await probeCodexHostedProtocol(await fixture(unsupported), process.env)).toMatchObject({ supported: false, reason: expect.stringContaining(reason) });
});

it('CLI 无法生成协议时保留原始错误，不冒充支持工具', async () => {
  expect(await probeCodexHostedProtocol(await fixture('command'), process.env)).toMatchObject({ supported: false, reason: expect.stringContaining('unknown command generate-json-schema') });
});
