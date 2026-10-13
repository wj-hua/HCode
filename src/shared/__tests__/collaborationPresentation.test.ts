// 展示关联只接受宿主身份；普通消息、跨项目和未知用量不能被重新解释。
import { describe, expect, it } from 'vitest';
import type { CollaborationSnapshot } from '../collaboration.js';
import { presentationBelongsToSource, presentationContent } from '../collaborationPresentation.js';
import { presentationForRun, presentationForDraft, mergePresentationEntry, presentationTaskForTurn, groupCollaborationSessions, usagePresentation, presentationTitle, collaborationInputTitle, collaborationGroupMatchesQuery } from '../collaborationPresentation.js';

const run: CollaborationSnapshot = {
  id: 'run', seq: 1, createdAt: 1, status: 'completed', stage: 'finished',
  params: { initiator: { agent: 'codex', sessionKey: 'source-key', resumeSessionId: 'source', projectPath: '/project', permissionMode: 'read-only' }, executor: { agent: 'claude' }, objective: '核对登录行为' },
  tasks: [{ id: 'task', agent: 'claude', sessionKey: 'worker-key', nativeSessionId: 'worker', role: 'execution', status: 'succeeded', presentation: { executionTurnId: 'live-turn', nativeTurnId: 'history-turn', projectPath: '/isolated', inputTitle: '宿主指令' } }],
  deliveries: [{ id: 'delivery', requestKey: 'request', objective: '核对表单', executor: { agent: 'claude' }, status: 'accepted', versions: [], reviews: [] }], summary: '已核对，未运行测试',
};
describe('协作展示的身份边界', () => {
  it('缺失的原生 id 不会把同后端专家线程当作主会话', () => {
    const entry = presentationForRun({ ...run, params: { ...run.params, initiator: { ...run.params.initiator, resumeSessionId: undefined } }, tasks: [] });
    expect(presentationBelongsToSource(entry, { agent: 'codex', projectPath: '/project', sessionKey: 'expert-key' })).toBe(false);
    expect(presentationBelongsToSource(entry, { agent: 'codex', projectPath: '/other', sessionKey: 'source-key' })).toBe(false);
    expect(presentationBelongsToSource(entry, { agent: 'codex', projectPath: '/project', sessionKey: 'source-key' })).toBe(true);
  });
  it('旧的已停止汇总不展示最新成功结果，回合错误不借用全局错误', () => {
    const entry = presentationForRun({ ...run, error: '新增资料尚未核对', tasks: [
      { ...run.tasks[0]!, id: 'stopped', role: 'synthesis', status: 'cancelled', error: '本回合已停止' },
      { ...run.tasks[0]!, id: 'current', role: 'synthesis', status: 'succeeded' },
    ] });
    expect(presentationContent(entry, entry.tasks[0]!)).toEqual({ error: '本回合已停止' });
    expect(presentationContent(entry, entry.tasks[1]!).summary).toBe(run.summary);
    expect(presentationContent(entry, { ...entry.tasks[1]!, role: 'planning' })).toEqual({ error: undefined });
    expect(presentationContent(entry).error).toBe('新增资料尚未核对');
  });
  it('只保存有界原生自动标题，长 JSON 正文不进入展示元数据', () => {
    const title = collaborationInputTitle('宿主规划' + '文'.repeat(2000) + '\n' + '{"private":"raw output"}');
    expect(title).toHaveLength(81);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toContain('private');
  });
  it('按界面角色搜索内部任务，不要求目标文本包含角色名', () => {
    const review = presentationForRun({ ...run, tasks: [{ ...run.tasks[0]!, role: 'review' }] });
    const group = groupCollaborationSessions([], [review], '/project').groups[0]!;
    expect(collaborationGroupMatchesQuery(group, '独立审查')).toBe(true);
    expect(collaborationGroupMatchesQuery(group, '不存在的专家')).toBe(false);
  });
  it('同原生标识的其他目录会话不被内部任务隐藏', () => {
    const ordinary = { id: 'worker', agent: 'claude' as const, projectPath: '/project', title: '普通会话', createdAt: 1, updatedAt: 2 };
    const grouped = groupCollaborationSessions([ordinary], [presentationForRun(run)], '/project');
    expect(grouped.ordinary).toEqual([ordinary]);
    expect(grouped.groups[0]?.sessions[0]?.projectPath).toBe('/isolated');
  });
  it('共用 UUID 的草案和 Run 不相互覆盖，迟到草案不会回退完成状态', () => {
    const entry = presentationForRun(run);
    const draft = presentationForDraft({ id: run.id, runId: run.id, revision: 1, createdAt: 0, status: 'started', params: run.params, sources: [], turns: run.tasks });
    expect(draft.id).not.toBe(entry.id);
    expect(mergePresentationEntry([draft], entry)).toEqual([entry]);
    expect(mergePresentationEntry([entry], draft)).toEqual([entry]);
  });
  it('实时和历史只按原生回合身份折叠，同样文字的普通回合不折叠', () => {
    const entry = presentationForRun(run);
    const source = { agent: 'claude' as const, projectPath: '/isolated', sessionId: 'worker', sessionKey: 'worker-key' };
    expect(presentationTaskForTurn([entry], source, 'live-turn')?.task.id).toBe('task');
    expect(presentationTaskForTurn([entry], source, 'history-turn')?.task.id).toBe('task');
    expect(presentationTaskForTurn([entry], source, 'ordinary-json-turn')).toBeUndefined();
    expect(presentationTaskForTurn([entry], { ...source, projectPath: '/other' }, 'history-turn')).toBeUndefined();
    expect(presentationTaskForTurn([entry], { ...source, agent: 'codex' }, 'history-turn')).toBeUndefined();
  });
  it('旧记录不猜测回合，内部会话仍按真实任务分组', () => {
    const legacy = presentationForRun({ ...run, tasks: run.tasks.map(({ presentation: _metadata, ...task }) => task) });
    expect(presentationTaskForTurn([legacy], { agent: 'claude', projectPath: '/project', sessionId: 'worker' }, 'history-turn')).toBeUndefined();
    const source = { id: 'source', agent: 'codex' as const, projectPath: '/project', title: '我的标题', createdAt: 1, updatedAt: 2 };
    const grouped = groupCollaborationSessions([source], [legacy], '/project');
    expect(grouped.ordinary).toEqual([source]);
    expect(grouped.groups[0]?.sessions[0]?.id).toBe('worker');
    expect(grouped.groups[0]?.sessions[0]?.title).toContain('执行');
  });
  it('把隔离会话归入源项目，导航仍使用真实目录，不污染另一项目', () => {
    const entry = presentationForRun(run);
    const grouped = groupCollaborationSessions([], [entry], '/project');
    expect(grouped.groups[0]?.sessions[0]?.projectPath).toBe('/isolated');
    expect(groupCollaborationSessions([], [entry], '/other').groups).toHaveLength(0);
  });
  it('缺失用量显示未知，不能显示零', () => {
    expect(usagePresentation(run.tasks)).toEqual({ knownTurns: 0, unknownTurns: 1 });
    expect(usagePresentation([{ ...run.tasks[0]!, usage: { inputTokens: 0, outputTokens: 0 } }])).toEqual({ knownTurns: 1, unknownTurns: 0, inputTokens: 0, outputTokens: 0 });
  });
  it('只换已记录的宿主自动标题，保留用户标题和其他项目标题', () => {
    const sourceRun = { ...run, tasks: [{ ...run.tasks[0]!, agent: 'codex' as const, sessionKey: 'source-key', nativeSessionId: 'source', role: 'planning' as const }] };
    const entry = presentationForRun(sourceRun);
    const source = { agent: 'codex' as const, projectPath: '/project', sessionId: 'source' };
    expect(presentationTitle('宿主指令', source, [entry])).toBe(run.params.objective);
    expect(presentationTitle('我重命名的项目', source, [entry])).toBe('我重命名的项目');
    expect(presentationTitle('宿主指令', { ...source, projectPath: '/other' }, [entry])).toBe('宿主指令');
  });
  it('规划期间原始首行尚未截短时也显示已关联的业务目标', () => {
    const prompt = '这是宿主规划指令。'.repeat(20);
    const sourceRun = { ...run, tasks: [{ ...run.tasks[0]!, agent: 'codex' as const, sessionKey: 'source-key', role: 'planning' as const, presentation: { executionTurnId: 'planning-turn', projectPath: '/project', inputTitle: collaborationInputTitle(prompt) } }] };
    const entry = presentationForRun(sourceRun);
    const source = { agent: 'codex' as const, projectPath: '/project', sessionKey: 'source-key' };
    expect(presentationTitle(prompt, source, [entry], true)).toBe(run.params.objective);
    const renamed = `${prompt.slice(0, 80)}用户新增备注`;
    expect(presentationTitle(renamed, source, [entry])).toBe(renamed);
  });
});
