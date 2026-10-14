// 团队目录持续列出全部专家；未打开报告时不渲染列表尾部预览。弹窗交互通过浏览器用户路径验收。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ExpertState } from '@hcode/shared/experts';
import { ExpertParticipantsSection } from './ExpertParticipantsSection';
import { ExpertReportPreview } from './ExpertReportPreview';
const state: ExpertState = {
  participants: (['ios', 'design', 'testing'] as const).map((role, index) => ({ id: role, role, backend: { agent: index === 1 ? 'codex' : 'claude' }, sessionKey: role, status: 'reported', versions: [{ id: `${role}-v1`, version: 1, hash: 'hash', summary: '报告', evidence: [] }], rawResults: [] })),
  reviews: [], activeIds: ['ios', 'design', 'testing'], partialAuthorized: false, rawSummaries: [],
};
describe('专家目录与报告预览', () => {
  it('团队以独立区域列出三位专家及各自报告入口', () => {
    const html = renderToStaticMarkup(createElement(ExpertParticipantsSection, { state, reading: false, openReport: async () => {} }));
    expect(html).toContain('aria-label="专家报告与互审"');
    for (const label of ['iOS 专家 · Claude Code', 'UI 设计专家 · Codex', '测试专家 · Claude Code']) {
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`aria-label="查看${label}的报告 v1"`);
    }
  });
  it('未选择报告时不在团队目录内占据预览或空状态区块', () => {
    const html = renderToStaticMarkup(createElement(ExpertReportPreview, { reportLabel: '', reading: false, error: '', onClose: () => {}, returnFocus: { current: null } }));
    expect(html).toBe('');
  });
});
