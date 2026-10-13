// 经公开草案服务验证规划隔离、确认和真实工作区/采纳路径。
import { readFile, readdir, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { codeDraftFixture } from './codeDraftFixture.js';
import { manifest } from '../workspaces/fileManifest.js';
import type { CodeDraft } from '../../../shared/codeDraft.js';
function edit(draft: CodeDraft) { return { objective: draft.params.objective, tasks: draft.params.tasks, reviewer: draft.params.reviewer, checks: draft.params.checks, acceptWorkspace: draft.params.acceptWorkspace }; }
it('真实文件推荐只生成待确认计划，不建立副本，双任务确认幂等并逐项安全采纳', async () => {
  const data = await codeDraftFixture();
  try {
    const before = await manifest(data.project), planned = await data.drafts.prepare((await data.drafts.create(data.input)).id, 1);
    expect(planned.status).toBe('ready'); expect(planned.params.tasks).toHaveLength(2);
    expect(planned.copyPaths).toEqual(before.entries.map(entry => entry.path));
    expect(await data.repository.list()).toEqual([]); expect(await readdir(data.project)).not.toContain('workspace');
    expect((await manifest(data.project)).hash).toBe(before.hash);
    await expect(data.drafts.confirm(planned.id, planned.revision)).rejects.toThrow(/确认/);
    const accepted = await data.drafts.update(planned.id, planned.revision, { ...edit(planned), acceptWorkspace: true });
    const [run, duplicate] = await Promise.all([data.drafts.confirm(accepted.id, accepted.revision), data.drafts.confirm(accepted.id, accepted.revision)]);
    expect(run.id).toBe(duplicate.id);
    await vi.waitFor(async () => expect((await data.collaboration.get(run.id)).stage).toBe('finished'), { timeout: 30_000 });
    const completed = await data.collaboration.get(run.id);
    expect(completed.status).toBe('completed'); expect(completed.tasks).toHaveLength(6);
    expect(completed.deliveries).toHaveLength(2); expect(completed.deliveries.every(value => value.status === 'accepted' && value.code!.validations.every(check => check.status === 'passed'))).toBe(true);
    expect((await manifest(data.project)).hash).toBe(before.hash);
    expect(completed.deliveries[0]!.code!.workspace.path).not.toBe(completed.deliveries[1]!.code!.workspace.path);
    for (const delivery of completed.deliveries) {
      const version = delivery.code!.versions.at(-1)!;
      const preview = await data.collaboration.adoptionPreview(run.id, version.id);
      expect(preview.eligible).toBe(true);
      expect((await data.collaboration.applyCandidate(run.id, { versionId: version.id, previewHash: preview.hash })).status).toBe('applied');
    }
    expect(await readFile(join(data.project, 'value.mjs'), 'utf8')).toContain('= 1');
    expect(await readFile(join(data.project, 'other.mjs'), 'utf8')).toContain('= 2');
    expect((await data.drafts.confirm(accepted.id, accepted.revision)).id).toBe(run.id);
  } finally { await data.cleanup(); }
});
it.each(['dependency', 'overlap', 'ancestor'] as const)('推荐 %s 必须明确阻止，不能建立副本', async scenario => {
  const data = await codeDraftFixture();
  try {
    const proposal = structuredClone(data.proposal());
    if (scenario === 'dependency') proposal.tasks[1]!.dependsOn = [proposal.tasks[0]!.requestKey];
    else if (scenario === 'overlap') proposal.tasks[1]!.allowedPaths = ['value.mjs'];
    else { proposal.tasks[0]!.allowedPaths = ['new-file']; proposal.tasks[1]!.allowedPaths = ['new-file/child.mjs']; }
    data.setProposal(proposal);
    const plan = await data.drafts.prepare((await data.drafts.create(data.input)).id, 1);
    expect(plan.status).toBe('blocked'); expect(plan.error).toMatch(scenario === 'dependency' ? /依赖/ : /重叠/);
    expect(await data.repository.list()).toEqual([]);
  } finally { await data.cleanup(); }
});
it('改动保存撤销确认；旧版本、缺少检查和 Gemini 写入不能执行', async () => {
  const data = await codeDraftFixture();
  try {
    const plan = await data.drafts.prepare((await data.drafts.create(data.input)).id, 1);
    const accepted = await data.drafts.update(plan.id, plan.revision, { ...edit(plan), acceptWorkspace: true });
    await expect(data.drafts.update(accepted.id, accepted.revision, { ...edit(accepted), objective: '扩大目标', acceptWorkspace: true })).rejects.toThrow(/保存/);
    const saved = await data.drafts.update(accepted.id, accepted.revision, { ...edit(accepted), objective: '仅修改两处', acceptWorkspace: false });
    expect(saved.params.acceptWorkspace).toBe(false);
    await expect(data.drafts.confirm(saved.id, accepted.revision)).rejects.toThrow(/版本/);
    await expect(data.drafts.update(saved.id, saved.revision, { ...edit(saved), checks: [], acceptWorkspace: true })).rejects.toThrow(/检查/);
    await expect(data.drafts.update(saved.id, saved.revision, { ...edit(saved), tasks: saved.params.tasks.map(task => ({ ...task, executor: { agent: 'agy' } })) } as never)).rejects.toThrow();
    expect(await data.repository.list()).toEqual([]);
  } finally { await data.cleanup(); }
});
it.each(['file', 'ignored', 'backend', 'script'] as const)('%s 版本变化使旧确认失效，不能复制或派发', async scenario => {
  const data = await codeDraftFixture();
  try {
    if (scenario === 'ignored') await writeFile(join(data.project, '.gitignore'), 'scratch.cache\n');
    const plan = await data.drafts.prepare((await data.drafts.create(data.input)).id, 1);
    const accepted = await data.drafts.update(plan.id, plan.revision, { ...edit(plan), acceptWorkspace: true });
    if (scenario === 'backend') data.setVersion('changed-version');
    else if (scenario === 'script') await writeFile(join(data.project, 'package.json'), '{"private":true,"scripts":{"test":"node --test"}}');
    else await writeFile(join(data.project, scenario === 'file' ? 'value.mjs' : 'scratch.cache'), 'changed');
    if (scenario === 'ignored') expect((await data.collaboration.inspectCodeProject(data.project)).gitStatus).toBe(plan.admission!.gitStatus);
    await expect(data.drafts.confirm(accepted.id, accepted.revision)).rejects.toThrow(/变化/);
    expect(await data.repository.list()).toEqual([]);
  } finally { await data.cleanup(); }
});
it('单任务保留准确写入范围，四回合完成，不产生第二次规划', async () => {
  const data = await codeDraftFixture();
  try {
    data.setProposal({ ...data.proposal(), tasks: data.proposal().tasks.slice(0, 1) });
    const plan = await data.drafts.prepare((await data.drafts.create(data.input)).id, 1);
    const accepted = await data.drafts.update(plan.id, plan.revision, { ...edit(plan), acceptWorkspace: true });
    const run = await data.drafts.confirm(accepted.id, accepted.revision);
    await vi.waitFor(async () => expect((await data.collaboration.get(run.id)).stage).toBe('finished'), { timeout: 30_000 });
    const result = await data.collaboration.get(run.id);
    expect(result.status).toBe('completed'); expect(result.tasks).toHaveLength(4);
    expect(result.deliveries).toHaveLength(1); expect(result.deliveries[0]!.code!.allowedPaths).toEqual(['value.mjs']);
  } finally { await data.cleanup(); }
});
it.each(['directory', 'symlink', 'missingCheck'] as const)('%s 在准入阶段明确阻止，不静默代选', async scenario => {
  const data = await codeDraftFixture();
  try {
    if (scenario === 'directory') await mkdir(join(data.project, 'existing-directory'));
    if (scenario === 'symlink') await symlink('value.mjs', join(data.project, 'alias.mjs'));
    if (scenario !== 'missingCheck') data.setProposal({ ...data.proposal(), tasks: [{ ...data.proposal().tasks[0]!, allowedPaths: [scenario === 'directory' ? 'existing-directory' : 'alias.mjs'] }] });
    const plan = await data.drafts.prepare((await data.drafts.create(data.input)).id, 1);
    if (scenario !== 'missingCheck') { expect(plan.status).toBe('blocked'); expect(plan.error).toMatch(scenario === 'directory' ? /普通文件/ : /链接/); expect(await data.repository.list()).toEqual([]); return; }
    const saved = await data.drafts.update(plan.id, plan.revision, { ...edit(plan), checks: [] });
    await expect(data.drafts.confirm(saved.id, saved.revision)).rejects.toThrow(/检查/);
  } finally { await data.cleanup(); }
});
it('七次规划与双任务执行共享十二回合，超额重新规划不能调用模型', async () => {
  const data = await codeDraftFixture();
  try {
    let draft = await data.drafts.create(data.input);
    for (let attempt = 0; attempt < 7; attempt++) draft = await data.drafts.prepare(draft.id, draft.revision);
    const calls = data.send.mock.calls.length;
    await expect(data.drafts.prepare(draft.id, draft.revision)).rejects.toThrow(/预算/);
    expect(data.send).toHaveBeenCalledTimes(calls);
    const accepted = await data.drafts.update(draft.id, draft.revision, { ...edit(draft), acceptWorkspace: true });
    const run = await data.drafts.confirm(accepted.id, accepted.revision);
    await vi.waitFor(async () => expect((await data.collaboration.get(run.id)).stage).toBe('finished'), { timeout: 30_000 });
    const completed = await data.collaboration.get(run.id);
    expect(completed.status, JSON.stringify({ status: completed.status, error: completed.error, tasks: completed.tasks.map(task => ({ role: task.role, status: task.status, error: task.error })), deliveries: completed.deliveries.map(delivery => ({ status: delivery.status, error: delivery.error })) })).toBe('completed'); expect(completed.tasks).toHaveLength(12);
  } finally { await data.cleanup(); }
});
it('资料不足保留空任务；用户明确填写、保存、接受后才可开始', async () => {
  const data = await codeDraftFixture();
  try {
    const manual = data.proposal().tasks.slice(0, 1).map(task => ({ ...task, executor: { agent: 'claude' as const } }));
    data.setProposal({ ...data.proposal(), confidence: 'needsInput', tasks: [] });
    const plan = await data.drafts.prepare((await data.drafts.create(data.input)).id, 1);
    expect(plan.status).toBe('editing'); expect(plan.params.tasks).toEqual([]);
    const saved = await data.drafts.update(plan.id, plan.revision, { ...edit(plan), tasks: manual });
    expect(saved.status).toBe('ready'); expect(saved.params.acceptWorkspace).toBe(false);
    const accepted = await data.drafts.update(saved.id, saved.revision, { ...edit(saved), acceptWorkspace: true });
    const run = await data.drafts.confirm(accepted.id, accepted.revision);
    await vi.waitFor(async () => expect((await data.collaboration.get(run.id)).status).toBe('completed'), { timeout: 30_000 });
  } finally { await data.cleanup(); }
});
it('未准入项目在规划前失败，不调用模型或建立副本', async () => {
  const data = await codeDraftFixture();
  try {
    const { unlink } = await import('node:fs/promises'); await unlink(join(data.project, 'package.json'));
    const draft = await data.drafts.create(data.input);
    await expect(data.drafts.prepare(draft.id, draft.revision)).rejects.toThrow(/Node/);
    expect(data.send).not.toHaveBeenCalled(); expect(await data.repository.list()).toEqual([]);
  } finally { await data.cleanup(); }
});
