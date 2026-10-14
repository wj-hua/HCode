import { expect, it } from 'vitest';
import { SessionExecutionService } from '../sessionExecutionService.js';
import type { AgentSendParams } from '../../agents/types.js';
it('普通消息原样发送并提供本回合工具，源回合终态会取消子调用等待', async () => {
  let sent!: AgentSendParams;
  let sourceSignal!: AbortSignal;
  const runtime = { root: '/project', instructions: '使用 call_agent', tools: [] };
  const execution = new SessionExecutionService({ prepare: async input => input, send: async input => { sent = input; return { sessionKey: input.sessionKey }; }, interrupt: async () => {}, failedToSend: () => {}, finishedSending: () => {}, ordinaryTools: (_params, _turnId, signal) => { sourceSignal = signal; return runtime; } });
  await execution.send({ agent: 'claude', sessionKey: 'source', projectPath: '/project', permissionMode: 'bypassPermissions', text: '后面都直接展示了 效果不行 你让codex调整吧' });
  expect(sent.hosted).toBe(runtime);
  expect(sent.text).toBe('后面都直接展示了 效果不行 你让codex调整吧');
  expect(sent.research).toBeUndefined();
  execution.acceptOutcome({ sessionKey: 'source', agent: 'claude', executionTurnId: sent.executionTurnId!, outcome: 'succeeded', text: '继续下一步' });
  expect(sourceSignal.aborted).toBe(true);
});
it('用户在当前回合切换到只读后，后续工具调用看到最新权限，不沿用旧的完全放行', async () => {
  let binding!: AgentSendParams;
  const execution = new SessionExecutionService({ prepare: async input => input, send: async input => ({ sessionKey: input.sessionKey }), interrupt: async () => {}, failedToSend: () => {}, finishedSending: () => {}, ordinaryTools: params => { binding = params; return { root: params.projectPath, tools: [] }; } });
  await execution.send({ agent: 'claude', sessionKey: 'source', projectPath: '/project', permissionMode: 'bypassPermissions', text: '当前请求' });
  execution.updateSourcePermission('source', 'plan');
  expect(binding.permissionMode).toBe('plan');
});
