// 普通入口保留用户消息和权限，交接上下文只传给 Provider；活动研究不接收普通交接。
import { expect, it, vi } from 'vitest';
import { SessionExecutionService } from '../sessionExecutionService.js';
import type { AgentSendParams } from '../../agents/types.js';
import type { ChatSendParams } from '../../../shared/types.js';

const input: ChatSendParams = { agent: 'codex', sessionKey: 'source', projectPath: '/project', permissionMode: 'full-access', text: '按已确认规则继续核对差异' };
it('普通续聊带宿主交接，显示文本、身份和用户权限不变', async () => {
  const send = vi.fn(async (params: AgentSendParams) => ({ sessionKey: params.sessionKey }));
  const host = { prepare: async (params: ChatSendParams) => params, send, interrupt: async () => {}, failedToSend: () => {}, finishedSending: () => {}, ordinaryContinuation: async () => '旧评审已结束，报告作为参考，按最新请求继续' };
  const execution = new SessionExecutionService(host);
  await execution.send(input);
  expect(send.mock.calls[0]![0]).toMatchObject({ ...input, ordinaryContinuation: '旧评审已结束，报告作为参考，按最新请求继续' });
  expect(send.mock.calls[0]![0].research).toBeUndefined();
});
it('真实研究入口不请求普通交接，原执行锁和输出配置仍有效', async () => {
  const context = vi.fn(async () => '不应注入');
  let execution: SessionExecutionService;
  const send = vi.fn(async (params: AgentSendParams) => {
    execution.acceptOutcome({ sessionKey: params.sessionKey, agent: params.agent, executionTurnId: params.executionTurnId!, outcome: 'succeeded', text: 'report' });
    return { sessionKey: params.sessionKey };
  });
  execution = new SessionExecutionService({ prepare: async params => params, send, interrupt: async () => {}, failedToSend: () => {}, finishedSending: () => {}, ordinaryContinuation: context });
  await execution.execute(input, { root: '/project', outputSchema: { type: 'object' } }, new AbortController().signal);
  expect(context).not.toHaveBeenCalled();
  expect(send.mock.calls[0]![0]).not.toHaveProperty('ordinaryContinuation');
  expect(send.mock.calls[0]![0].research?.outputSchema).toEqual({ type: 'object' });
  execution.reserve(input.sessionKey, 'run');
  await expect(execution.send(input)).rejects.toThrow('协作');
  expect(context).not.toHaveBeenCalled();
});
