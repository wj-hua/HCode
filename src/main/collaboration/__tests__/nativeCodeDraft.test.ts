// U3 真实原会话规划、Claude/Codex 独立代码交付、阻塞修订及逐项采纳；不替换模型结果。
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
vi.mock('../../util/trash.js', () => ({ trashPaths: async () => { throw new Error('验收禁止删除原生历史'); } }));
import { nativeFixture } from './nativeFixture.js';
import { CodeDraftService } from '../drafts/codeDraftService.js';
import { manifest } from '../workspaces/fileManifest.js';
const exec = promisify(execFile);
const GOAL = '请制定恰好两项互不依赖且文件不重叠的代码任务。任务一：divide.mjs 对任何 divisor === 0（正数/0、0/0、负数/0、-0）抛 RangeError，非零正常除法保持正确；只允许 divide.mjs 和新建 zero.test.mjs，保留全部已有测试并新增所有这些边界测试。缺任一规则或边界测试均阻塞。任务二：label.mjs 的 formatLabel 对字符串做 trim，空字符串或全空白返回 Untitled，非字符串抛 TypeError；只允许 label.mjs 和新建 label.test.mjs，完整覆盖这些规则。保留 baseline.test.mjs、package.json 和其他原始文件，不削弱测试，不修改原项目，不提交或推送。宿主检查、独立审查及按阻塞意见修订后，各自交付待采纳候选，不自动合并或采纳。';
it.skipIf(process.env.HCODE_NATIVE_CODE_DRAFT !== '1')('真实双任务代码计划确认、阻塞修订复审、冲突拒绝及逐项采纳', async () => {
  let first = true, overlap = false;
  const data = await nativeFixture('hcode-u3-native-', input => {
    const writer = input.research?.tools?.some(tool => tool.name === 'write_file');
    if (writer && input.text.includes('divide.mjs') && input.text.includes('zero.test.mjs') && first) {
      first = false;
      return { ...input, text: '你是隔离代码执行者。仅用宿主 read_file/list_files/write_file/delete_file，不执行命令。此验收初版只对 value > 0 && divisor === 0 抛 RangeError，其他保留原样；新增 zero.test.mjs 只验证正数除零，故意暂时遗漏 0/0、负数除零与 -0。不得修改 baseline.test.mjs 或其他文件。独立审查会给出完整目标，之后必须按意见修订。仅允许 divide.mjs 和 zero.test.mjs。expectedHash 必须匹配实际读取，新文件为 null。报告逐字引用一条重新读取的实际完整源码行，startLine=endLine；不声称已运行测试。' };
    }
    return writer ? { ...input, text: input.text + '\n报告证据仅引用一条重新读取的实际完整原文行，startLine=endLine，保留空格。不声称自己运行宿主检查。' } : input;
  }, snapshot => { if (snapshot.tasks.filter(turn => turn.role === 'execution' && turn.status === 'running').length >= 2) overlap = true; });
  const drafts = new CodeDraftService(join(data.root, 'code-plans'), data.service, data.execution, data.agents);
  try {
    const project = join(data.root, 'project'); await mkdir(project);
    await writeFile(join(project, 'package.json'), '{"private":true,"type":"module"}');
    await writeFile(join(project, 'divide.mjs'), 'export function divide(value, divisor) {\n  return value / divisor;\n}\n');
    await writeFile(join(project, 'label.mjs'), 'export function formatLabel(value) {\n  return value;\n}\n');
    await writeFile(join(project, 'baseline.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { divide } from './divide.mjs';\nimport { formatLabel } from './label.mjs';\ntest('baseline',()=>{assert.equal(divide(8,2),4);assert.equal(divide(-6,3),-2);assert.equal(formatLabel('Home'),'Home');});\n");
    await exec('git', ['init', project]); await exec('git', ['-C', project, 'add', '.']);
    await exec('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=test@invalid.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline']);
    await writeFile(join(project, 'untracked.txt'), 'retain user context');
    const baseline = await manifest(project);
    const created = await drafts.create({ initiator: { agent: 'claude', sessionKey: randomUUID(), projectPath: project, permissionMode: 'bypassPermissions', model: 'sonnet' }, objective: GOAL, backendPreferences: [{ agent: 'claude', model: 'sonnet' }, { agent: 'codex' }] });
    const planned = await drafts.prepare(created.id, created.revision);
    expect(planned.status, JSON.stringify(planned)).toBe('ready'); expect(planned.params.tasks).toHaveLength(2);
    expect(await data.repository.list()).toEqual([]); expect((await manifest(project)).hash).toBe(baseline.hash);
    const confirmed = await drafts.update(planned.id, planned.revision, { objective: planned.params.objective, tasks: planned.params.tasks, reviewer: undefined, checks: planned.params.checks, acceptWorkspace: true });
    const [run, same] = await Promise.all([drafts.confirm(confirmed.id, confirmed.revision), drafts.confirm(confirmed.id, confirmed.revision)]);
    expect(same.id).toBe(run.id);
    await vi.waitFor(async () => expect((await data.service.get(run.id)).stage).toBe('finished'), { timeout: 600_000, interval: 1000 });
    const completed = await data.service.get(run.id);
    expect(completed.status, JSON.stringify(completed)).toBe('completed'); expect(overlap).toBe(true);
    const zero = completed.deliveries.find(delivery => delivery.code!.allowedPaths!.includes('divide.mjs'))!, label = completed.deliveries.find(delivery => delivery.code!.allowedPaths!.includes('label.mjs'))!;
    expect(zero.reviews[0]!.verdict).toBe('changesRequested'); expect(zero.reviews.at(-1)!.verdict).toBe('approved'); expect(zero.code!.versions.length).toBeGreaterThanOrEqual(2);
    expect(label.reviews.at(-1)!.verdict).toBe('approved');
    expect(completed.deliveries.every(delivery => delivery.code!.validations.some(check => check.versionId === delivery.code!.versions.at(-1)!.id && check.status === 'passed'))).toBe(true);
    expect((await manifest(project)).hash).toBe(baseline.hash);
    expect(completed.tasks.filter(turn => turn.role === 'planning' || turn.role === 'synthesis').every(turn => turn.nativeSessionId === planned.params.initiator.resumeSessionId)).toBe(true);
    const firstVersion = zero.code!.versions.at(-1)!, secondVersion = label.code!.versions.at(-1)!;
    const initial = await data.service.adoptionPreview(run.id, firstVersion.id); expect(initial.eligible).toBe(true);
    const applied = await data.service.applyCandidate(run.id, { versionId: firstVersion.id, previewHash: initial.hash }); expect(applied.status).toBe('applied');
    const old = await data.service.adoptionPreview(run.id, secondVersion.id), originalLabel = await readFile(join(project, 'label.mjs'), 'utf8');
    await writeFile(join(project, 'label.mjs'), originalLabel + '// 用户后续修改\n');
    const conflict = await data.service.adoptionPreview(run.id, secondVersion.id); expect(conflict.eligible).toBe(false); expect(conflict.conflicts.some(entry => entry.path === 'label.mjs')).toBe(true);
    await expect(data.service.applyCandidate(run.id, { versionId: secondVersion.id, previewHash: old.hash })).rejects.toThrow(/偏离/);
    await writeFile(join(project, 'label.mjs'), originalLabel);
    const current = await data.service.adoptionPreview(run.id, secondVersion.id); expect(current.eligible).toBe(true);
    const secondApplied = await data.service.applyCandidate(run.id, { versionId: secondVersion.id, previewHash: current.hash }); expect(secondApplied.status).toBe('applied');
    const combined = await exec(process.execPath, ['--test'], { cwd: project }); expect(combined.stdout).toContain('fail 0');
    expect(await readFile(join(project, 'untracked.txt'), 'utf8')).toBe('retain user context');
    expect((await drafts.confirm(confirmed.id, confirmed.revision)).id).toBe(run.id);
    if (process.env.HCODE_NATIVE_EVIDENCE_DIR) {
      const evidence = process.env.HCODE_NATIVE_EVIDENCE_DIR; await mkdir(evidence, { recursive: true });
      await cp(join(data.root, 'code-plans'), join(evidence, 'code-plans'), { recursive: true }); await cp(project, join(evidence, 'original-after-adoption'), { recursive: true });
      await writeFile(join(evidence, 'u3-verification.json'), JSON.stringify({ planned, completed, final: await data.service.get(run.id), baselineHash: baseline.hash, overlap, applied, conflict, secondApplied, combined: combined.stdout }, null, 2));
    }
  } finally { drafts.dispose(); await data.cleanup(); }
}, 660_000);
