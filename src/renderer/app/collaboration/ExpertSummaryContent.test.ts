// 通过公开渲染边界确认长结论及所有结果类别直接可读，不依赖组件私有函数。
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExpertSummaryContent } from './ExpertSummaryContent';
describe('专家汇总正文', () => {
  it('默认展示长结论、共识、分歧、待验证项、局限和可操作证据', () => {
    const long = '这是完整评审结论。'.repeat(100) + '结论结尾';
    const html = renderToStaticMarkup(createElement(ExpertSummaryContent, {
      summary: { summary: long, consensus: [{ statement: '共识正文', sources: [{ expertId: 'ios', versionId: 'v1', claimId: 'claim' }] }], disagreements: [{ statement: '分歧正文', sources: [] }], unverified: [{ statement: '待验证正文', sources: [] }], limitations: ['未运行设备验收'], failedExperts: ['testing'] },
      label: () => '测试专家', reference: () => 'iOS 专家 · v1', onReference: () => {},
    }));
    for (const content of [long, '共识正文', '分歧正文', '待验证正文', '未运行设备验收', '未参与本轮互审：测试专家', 'iOS 专家 · v1']) expect(html).toContain(content);
    expect(html).not.toContain('<details');
    expect(html).toContain('<button');
  });
});
