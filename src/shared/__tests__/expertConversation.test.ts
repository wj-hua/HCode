// 通过只读展示接口验证完整结果和重试状态，不依赖渲染组件内部结构。
import { describe, it, expect } from 'vitest';
import { presentationForRun } from '../collaborationPresentation.js';
import type { CollaborationSnapshot } from '../collaboration.js';
const report = { id: 'v1', version: 1, hash: 'hash', summary: '报告', evidence: [] };
const review = { id: 'r1', targetId: 'ios', reviewerId: 'design', versionId: 'v1', versionHash: 'hash', sessionKey: 'review', status: 'failed' as const, error: '引用不匹配', rawResults: [] };
const run: CollaborationSnapshot = {
  id: 'run', seq: 1, createdAt: 1, status: 'running', stage: 'peerReview', deliveries: [], tasks: [],
  params: { mode: 'experts', objective: '核对适配', initiator: { agent: 'codex', projectPath: '/project', sessionKey: 'source', permissionMode: 'read-only' }, experts: [] },
  experts: { participants: [
    { id: 'ios', role: 'ios', backend: { agent: 'claude' }, sessionKey: 'ios', status: 'reported', versions: [report], rawResults: [] },
    { id: 'design', role: 'design', backend: { agent: 'codex' }, sessionKey: 'design', status: 'researching', versions: [], rawResults: [] },
  ], activeIds: ['ios', 'design'], reviews: [review], partialAuthorized: false, rawSummaries: [] },
};
describe('专家会话展示', () => {
  it('完整保留结论、分歧、待验证项、局限和冻结引用', () => {
    const summary = { summary: '总评', consensus: [{ statement: '共识', sources: [{ expertId: 'ios', versionId: 'v1', claimId: 'claim' }] }], disagreements: [{ statement: '分歧', sources: [] }], unverified: [{ statement: '未验证', sources: [] }], limitations: ['未运行测试'], failedExperts: [] };
    const entry = presentationForRun({ ...run, status: 'completed', stage: 'finished', experts: { ...run.experts!, summary } });
    expect(entry.experts?.summary).toEqual(summary);
    expect(entry.experts?.references.v1).toBe('iOS 专家 · Claude Code · v1');
    expect(entry.experts?.busy).toBe(false);
  });
  it('真实失败保持可见，同一审查的重试不会累加或借用旧失败', () => {
    expect(presentationForRun(run).experts?.participants.find(expert => expert.id === 'design')).toMatchObject({ state: '互审失败', busy: false, error: '引用不匹配' });
    const retried = presentationForRun({ ...run, experts: { ...run.experts!, reviews: [review, { ...review, id: 'r2', status: 'completed', error: undefined }] } });
    expect(retried.experts?.review).toEqual({ completed: 1, total: 1 });
    expect(retried.experts?.participants.find(expert => expert.id === 'design')).toMatchObject({ state: '互审已完成', error: undefined });
  });
  it('暂停与停止时不保留转圈，当前版本不会借用旧报告的互审', () => {
    const paused = presentationForRun({ ...run, status: 'paused' });
    expect(paused.experts?.participants.every(expert => !expert.busy)).toBe(true);
    const newer = presentationForRun({ ...run, experts: { ...run.experts!, participants: [{ ...run.experts!.participants[0]!, versions: [report, { ...report, id: 'v2', version: 2 }] }] } });
    expect(newer.experts?.review).toEqual({ completed: 0, total: 0 });
  });
  it('独立研究显示实际报告数量，不从成功回合或模型文字推断完成', () => {
    const entry = presentationForRun({ ...run, stage: 'expertResearch' });
    expect(entry.experts?.research).toEqual({ completed: 1, total: 2 });
    expect(entry.experts?.participants[1]).toMatchObject({ state: '独立研究中', busy: true });
  });
});
