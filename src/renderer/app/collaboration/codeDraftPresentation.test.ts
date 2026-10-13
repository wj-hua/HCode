// 验证用户可见准入原因；与主进程共用真实纯规则，不模拟判断。
import { expect, it } from 'vitest';
import type { CodeDraft } from '@hcode/shared/codeDraft';
import type { CollaborationCapabilities } from '@hcode/shared/collaboration';
import { codePlanIssues } from './codeDraftPresentation';
const capabilities: CollaborationCapabilities[] = [{ agent: 'claude', canInitiate: true, canExecute: true, canExecuteCode: true, canReview: true, reason: '准入通过' }, { agent: 'agy', canInitiate: false, canExecute: true, canExecuteCode: false, canReview: true, reason: '只读', models: [{ value: 'gemini-fixture', label: 'Gemini' }] }];
const draft: CodeDraft = { id: 'draft', createdAt: 0, revision: 2, status: 'ready', confidence: 'ready', sources: [], turns: [], copyPaths: ['src/value.mjs'], capabilities: [], admission: { hash: 'hash', fileCount: 1, bytes: 1, checks: [{ id: 'node-test', executable: 'node', args: ['--test'], description: '实际检查' }], gitStatus: '', sourceRevision: 'baseline', strategy: 'full-copy' }, params: { initiator: { agent: 'claude', sessionKey: 'source', projectPath: '/project', permissionMode: 'default' }, objective: '修改常量', backendPreferences: [{ agent: 'claude' }], tasks: [{ requestKey: 'one', name: '常量', reason: '需求', objective: '修改常量并保留测试', allowedPaths: ['src/value.mjs'], executor: { agent: 'claude' }, dependsOn: [] }], checks: ['node-test'], acceptWorkspace: false } };
it('开始前分别解释未保存、未确认和当前会话限制', () => {
  const issues = codePlanIssues(draft, draft.params, capabilities, true, '附件暂不支持');
  expect(issues).toEqual(expect.arrayContaining(['附件暂不支持', expect.stringContaining('保存'), expect.stringContaining('确认文件范围')]));
  expect(codePlanIssues(draft, { ...draft.params, acceptWorkspace: true }, capabilities, false)).toEqual([]);
});
it('路径、依赖、祖先重叠和缺检查在界面立即可见', () => {
  const tasks = [draft.params.tasks[0]!, { ...draft.params.tasks[0]!, requestKey: 'two', allowedPaths: ['src/value.mjs/child'], dependsOn: ['one'] }];
  expect(codePlanIssues(draft, { ...draft.params, tasks, checks: [] }, capabilities, false)).toEqual(expect.arrayContaining([expect.stringContaining('依赖'), expect.stringContaining('重叠'), expect.stringContaining('检查')]));
  expect(codePlanIssues(draft, { ...draft.params, tasks: [{ ...draft.params.tasks[0]!, allowedPaths: ['../outside'] }] }, capabilities, false)).toEqual(expect.arrayContaining([expect.stringContaining('路径')]));
});
it('Gemini 不能执行代码；审查必须选账号可用模型', () => {
  expect(codePlanIssues(draft, { ...draft.params, reviewer: { agent: 'agy' } }, capabilities, false)).toEqual(expect.arrayContaining([expect.stringContaining('Gemini')]));
  expect(codePlanIssues(draft, { ...draft.params, reviewer: { agent: 'agy', model: 'gemini-fixture' }, acceptWorkspace: true }, capabilities, false)).toEqual([]);
});
