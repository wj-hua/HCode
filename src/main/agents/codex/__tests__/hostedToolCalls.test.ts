// 原生请求的公开边界：宿主动作幂等、身份拒绝和取消；不替换参数规则或工具分发。
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HostedToolCalls } from '../hostedToolCalls.js';
import type { ServerRequest } from '../appServerClient.js';
const request = (id: number, callId = 'call', argumentsValue: unknown = { taskId: 'task' }): ServerRequest => ({ id, method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn', callId, tool: 'hcode_delegate_task', arguments: argumentsValue } });
function fixture() {
  const replies: { id: number | string; result: unknown }[] = [];
  const failures: unknown[] = [];
  let finish: (value: unknown) => void = () => {};
  const execute = vi.fn(async () => await new Promise((resolve) => { finish = resolve; }));
  const runtime = { root: '/fixture', tools: [{ name: 'delegate_task', description: 'delegate', schema: { taskId: z.string() }, execute }] };
  const calls = new HostedToolCalls({ respond: (id, result) => replies.push({ id, result }), failure: (error) => failures.push(error) });
  calls.begin('thread', 'turn', runtime);
  return { calls, runtime, replies, failures, execute, finish: () => finish({ taskId: 'actual-delivery' }) };
}
it('同一 callId 与参数只派发一次，不同 JSON-RPC id 共享真实结果', async () => {
  const data = fixture();
  data.calls.handle(request(1)); data.calls.handle(request(1)); data.calls.handle(request(2));
  expect(data.execute).toHaveBeenCalledTimes(1);
  data.finish();
  await vi.waitFor(() => expect(data.replies).toHaveLength(2));
  expect(data.replies.map((entry) => entry.id)).toEqual([1, 2]);
  expect(data.replies.every((entry) => JSON.stringify(entry.result).includes('actual-delivery'))).toBe(true);
});
it('重复身份参数冲突、跨线程/回合、未知工具和越权参数明确失败', async () => {
  const data = fixture();
  data.calls.handle(request(1));
  data.calls.handle(request(2, 'call', { taskId: 'different' }));
  data.calls.handle({ ...request(3, 'outside-thread'), params: { ...request(3).params, threadId: 'outside' } });
  data.calls.handle({ ...request(4, 'old-turn'), params: { ...request(4).params, turnId: 'old' } });
  data.calls.handle(request(5, 'extra-argument', { taskId: 'task', runId: 'other' }));
  data.calls.handle({ ...request(6, 'unknown-tool'), params: { ...request(6).params, callId: 'unknown-tool', tool: 'exec_command' } });
  data.finish();
  await vi.waitFor(() => expect(data.replies).toHaveLength(6));
  expect(data.execute).toHaveBeenCalledTimes(1);
  expect(data.replies.filter((entry) => entry.id !== 1).every((entry) => (entry.result as { success: boolean }).success === false)).toBe(true);
});
it('取消回应原请求一次，迟到结果不进入新回合，也不重新执行旧调用', async () => {
  const data = fixture();
  data.calls.handle(request(1)); data.calls.cancel();
  data.finish();
  await Promise.resolve(); await Promise.resolve();
  expect(data.replies).toEqual([{ id: 1, result: expect.objectContaining({ success: false }) }]);
  data.calls.handle(request(2));
  expect(data.execute).toHaveBeenCalledTimes(1);
  expect(data.replies[1]!.result).toMatchObject({ success: false });
  data.calls.begin('thread', 'new-turn', data.runtime);
  data.calls.handle({ ...request(3), params: { ...request(3).params, turnId: 'new-turn' } });
  data.finish();
  await vi.waitFor(() => expect(data.replies).toHaveLength(3));
  expect(data.execute).toHaveBeenCalledTimes(2);
  expect(data.failures).toEqual([]);
});
