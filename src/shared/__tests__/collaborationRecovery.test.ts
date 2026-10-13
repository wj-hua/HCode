// 验证用户可见的目标、阶段与阻止原因；旧记录不补造停止确认或预算。
import { expect, it } from 'vitest';
import type { CollaborationSnapshot } from '../collaboration.js';
import { recoveryOptions, recoveryTarget } from '../collaborationRecovery.js';

const run: CollaborationSnapshot = {
  id: 'run', seq: 1, createdAt: 1, status: 'awaitingUser', stage: 'finished', tasks: [],
  params: { initiator: { agent: 'claude', sessionKey: 'source', projectPath: '/project', permissionMode: 'default' }, executor: { agent: 'codex' }, objective: '核对' },
  deliveries: [{ id: 'target', requestKey: 'internal-key', objective: '核对 source.ts 的期望值', executor: { agent: 'codex' }, status: 'awaitingUser', versions: [], reviews: [] }],
};
it('资料目标和续跑预览按真实任务显示，缺报告只允许重新调研', () => {
  expect(recoveryTarget(run, 'target')).toContain('核对 source.ts 的期望值');
  expect(recoveryTarget(run, 'target')).not.toContain('internal-key');
  const options = recoveryOptions(run);
  expect(options[0]?.params).toEqual({ deliveryId: 'target', action: 'execute' });
  expect(options[0]?.stages).toContain('其他任务不重做');
  expect(options[0]?.blocked).toBeUndefined();
  expect(options[1]?.blocked).toContain('尚无有效报告');
});
it('待回答问题阻止指定续跑，保存回复后解除，预算仍累计', () => {
  const question = { id: 'q', deliveryId: 'target', requestKey: 'q', sender: 'worker' as const, recipient: 'initiator' as const, type: 'clarification' as const, text: '期望值？', createdAt: 1 };
  expect(recoveryOptions({ ...run, messages: [question] })[0]?.blocked).toContain('澄清');
  const answer = { ...question, id: 'a', type: 'answer' as const, sender: 'user' as const, replyTo: 'q' };
  expect(recoveryOptions({ ...run, messages: [question, answer] })[0]?.blocked).toBeUndefined();
  const tasks = Array.from({ length: 10 }, (_, index) => ({ id: String(index), agent: 'codex' as const, sessionKey: 'worker', role: 'execution' as const, status: 'succeeded' as const }));
  expect(recoveryOptions({ ...run, tasks })[0]?.blocked).toContain('预算不足');
});
it.each(['running', 'stopping', 'cancelled'] as const)('%s 状态不提供续跑计划', status => {
  expect(recoveryOptions({ ...run, status })).toEqual([]);
});
