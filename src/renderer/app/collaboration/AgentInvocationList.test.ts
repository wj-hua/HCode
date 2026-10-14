// 通过实际列表的可读内容验证重复调用；历史交互另外通过浏览器用户路径验收。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { AgentInvocation } from '@hcode/shared/agentInvocation';
vi.mock('../bridge', () => ({ hcode: { invoke: vi.fn(), on: vi.fn() } }));
vi.mock('@/components/ui/toast.js', () => ({ toast: vi.fn() }));
import { AgentInvocationList } from './AgentInvocationList';

function call(id: string, status: AgentInvocation['status'], createdAt: number): AgentInvocation {
  return { id, status, createdAt, seq: 1, source: { agent: 'claude', sessionKey: 'source', projectPath: '/project', permissionMode: 'default' }, sourceTurnId: `turn-${id}`, input: { agent: 'codex', mode: 'execute', prompt: `任务-${id}` }, sessionKey: `worker-${id}`, ...(status === 'succeeded' ? { output: `结果-${id}` } : {}) };
}
const render = (calls: AgentInvocation[]) => renderToStaticMarkup(createElement(AgentInvocationList, { calls }));

it('第二次调用时只默认展示当前调用，旧结果保留在折叠历史入口', () => {
  const html = render([call('second', 'running', 2), call('first', 'succeeded', 1)]);
  expect(html).toContain('任务-second');
  expect(html).not.toContain('结果-first');
  expect(html).toContain('历史调用（1）');
});
it('全部结束后展示最新结果，更早的失败记录也归入历史', () => {
  const html = render([call('third', 'succeeded', 3), call('second', 'failed', 2), call('first', 'succeeded', 1)]);
  expect(html).toContain('结果-third');
  expect(html).not.toContain('任务-second');
  expect(html).not.toContain('结果-first');
  expect(html).toContain('历史调用（2）');
});
it('并行活动调用和等待停止确认的调用全部保持可见', () => {
  const html = render([call('completed', 'succeeded', 4), call('review', 'running', 3), call('stopping', 'stopping', 2), call('first', 'succeeded', 1)]);
  expect(html).toContain('任务-review');
  expect(html).toContain('任务-stopping');
  expect(html).not.toContain('结果-completed');
  expect(html).toContain('历史调用（2）');
});
it('单条调用直接展示，没有历史入口；无记录时不展示空列表', () => {
  expect(render([call('only', 'failed', 1)])).toContain('调用失败');
  expect(render([call('only', 'failed', 1)])).not.toContain('历史调用');
  expect(render([])).toBe('');
});
