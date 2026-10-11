// S5a/S1b/S4 双向代码候选、真实检查及独立阻塞审查与修订；不伪造模型输出。
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
vi.mock('../../util/trash.js', () => ({ trashPaths: async () => { throw new Error('代码验收禁止删除原生历史'); } }));
import { nativeFixture, selectGeminiModel } from './nativeFixture.js';
import { manifest } from '../workspaces/fileManifest.js';
const exec = promisify(execFile);
async function verifyNativeCodeDelivery(initiatorAgent: 'claude' | 'codex', reviewerAgent?: 'agy') {
  let first = true;
  const executorAgent = initiatorAgent === 'claude' ? 'codex' : 'claude';
  const data = await nativeFixture('hcode-s5a-native-', (input) => {
    if (input.agent === executorAgent && first) {
      first = false;
      return { ...input, text: '你是隔离代码执行者。只在候选目录工作：宿主 read_file 返回 hash，write_file 以 expectedHash 写入；Claude 工具有 mcp__hcode__ 前缀，Codex 有 hcode_ 前缀；新文件 null。初版目标仅为 divide.mjs 增加正数除以零的 RangeError，保持正常除法。使用 value > 0 && divisor === 0 条件；初版保留现有测试，暂不覆盖 0/0，后续独立审查将给完整验收要求。只用宿主工具，不运行命令、不提权。完成后按 schema 输出真实代码引用报告。' };
    }
    return input;
  }, undefined, undefined, reviewerAgent === "agy");
  const reviewerModel = reviewerAgent ? await selectGeminiModel(data.agents) : undefined;
  const project = join(data.root, 'project');
  let cleanup = data.cleanup;
  try {
    await mkdir(project);
    await writeFile(join(project, 'package.json'), '{"name":"hcode-native-code-fixture","private":true,"type":"module"}');
    await writeFile(join(project, 'divide.mjs'), 'export function divide(value, divisor) {\n  return value / divisor;\n}\n');
    await writeFile(join(project, 'divide.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { divide } from './divide.mjs';\ntest('normal division', () => { assert.equal(divide(8, 2), 4); assert.equal(divide(-6, 3), -2); });\n");
    await exec('/usr/bin/git', ['init', project]);
    await exec('/usr/bin/git', ['-C', project, 'add', '.']);
    await exec('/usr/bin/git', ['-c', 'user.name=HCode test', '-c', 'user.email=test@invalid.local', '-c', 'commit.gpgsign=false', '-C', project, 'commit', '-m', 'fixture baseline']);
    await writeFile(join(project, 'untracked.txt'), 'retain current context');
    const original = await manifest(project), admission = await data.service.inspectCodeProject(project);
    const start = await data.service.start({ initiator: { agent: initiatorAgent, sessionKey: randomUUID(), projectPath: project, permissionMode: 'default', ...(initiatorAgent === 'claude' ? { model: 'sonnet' } : {}) }, executor: { agent: executorAgent, ...(executorAgent === 'claude' ? { model: 'sonnet' } : {}) }, ...(reviewerAgent ? { reviewer: { agent: reviewerAgent, model: reviewerModel } } : {}), objective: '只委派一个完整代码任务：修改 divide.mjs，任何 divisor === 0（包括 0/0、负数除以零、-0）均抛 RangeError；正常与负数除法结果保持不变。保留现有检查并添加完整边界回归测试。缺少 0/0 处理或边界覆盖是阻塞问题。只生成独立副本中的待采纳候选，不修改原项目。', code: { admissionHash: admission.hash, checks: ['node-test'] } });
    await vi.waitFor(() => expect(data.latest()?.stage).toBe('finished'), { timeout: 600_000, interval: 1000 });
    const result = await data.service.get(start.id);
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.deliveries).toHaveLength(1);
    const delivery = result.deliveries[0]!;
    expect(delivery.reviews[0]?.verdict).toBe('changesRequested');
    expect(delivery.reviews.at(-1)?.verdict).toBe('approved');
    expect(result.code!.versions.length).toBeGreaterThanOrEqual(2);
    expect(result.code!.validations.at(-1)?.status).toBe('passed');
    expect(new Set(result.tasks.filter((task) => task.role === 'execution').map((task) => task.nativeSessionId)).size).toBe(1);
    expect(new Set(result.tasks.filter((task) => task.role === 'review').map((task) => task.nativeSessionId)).size).toBe(delivery.reviews.length);
    expect((await manifest(project)).hash).toBe(original.hash);
    expect(await readFile(join(result.code!.workspace.path, 'untracked.txt'), 'utf8')).toBe('retain current context');
    const candidate = await data.service.candidatePreview(start.id, result.code!.versions.at(-1)!.id);
    expect(candidate.changes.some((change) => change.path === 'divide.mjs')).toBe(true);
    expect(result.summary).toBeTruthy();
    expect((await data.repository.load(start.id)).code!.phase).toBe('candidate');
    expect(result.tasks.filter((task) => task.role === 'planning' || task.role === 'synthesis').every((task) => task.agent === initiatorAgent)).toBe(true);
    expect(delivery.reviews.every((review) => review.reviewer?.agent === (reviewerAgent ?? initiatorAgent))).toBe(true);
    if (initiatorAgent === 'codex') {
      data.service.dispose(); data.agents.dispose();
      const restored = await nativeFixture('hcode-s1b-restarted', undefined, undefined, data.root, reviewerAgent === 'agy');
      cleanup = restored.cleanup;
      expect((await restored.service.get(start.id)).status).toBe('completed');
      expect(restored.outcomes).toHaveLength(0);
      await restored.service.controls.resume(start.id, { action: 'review', deliveryId: delivery.id });
      await vi.waitFor(() => expect(restored.latest()?.stage).toBe('finished'), { timeout: 300_000, interval: 1000 });
      const resumed = await restored.service.get(start.id);
      expect(resumed.status, JSON.stringify(resumed)).toBe('completed');
      expect(resumed.tasks.filter((task) => task.role === 'synthesis').at(-1)?.nativeSessionId).toBe(result.tasks.find((task) => task.role === 'planning')!.nativeSessionId);
      const before = restored.outcomes.length;
      await restored.execution.send({ ...resumed.params.initiator, text: '协作已结束。这是普通会话恢复验收，不调用工具、不读取或修改文件，只回复 S1b普通会话恢复成功。' });
      await vi.waitFor(() => expect(restored.outcomes.length).toBeGreaterThan(before), { timeout: 180_000, interval: 1000 });
      expect(restored.outcomes.at(-1)).toMatchObject({ outcome: 'succeeded', nativeSessionId: resumed.params.initiator.resumeSessionId });
      expect(restored.outcomes.at(-1)!.text).toContain('S1b普通会话恢复成功');
      expect((await manifest(project)).hash).toBe(original.hash);
    }
  } finally { await cleanup(); }
}
it.skipIf(process.env.HCODE_NATIVE_CODE !== '1')('S5a 真实隔离实现、检查、独立阻塞审查、修订复验及原会话汇总', async () => { await verifyNativeCodeDelivery('claude'); }, 660_000);
it.skipIf(process.env.HCODE_NATIVE_CODEX_SOURCE !== '1')('S1b 当前 Codex 委派 Claude、真实代码修订复审、重启后显式重审和恢复普通会话', async () => { await verifyNativeCodeDelivery('codex'); }, 1_140_000);

it.skipIf(process.env.HCODE_NATIVE_AGY_CODE_REVIEW !== '1')('S4 Codex 委派 Claude 代码实现，Gemini 独立阻塞审查与复审、重建后复审及原会话恢复', async () => { await verifyNativeCodeDelivery('codex', 'agy'); }, 1_140_000);
