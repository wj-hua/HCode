// 通过公开交接入口检查原生身份、旧报告参考、重启与无记录场景；宿主存储查询是唯一替代边界。
import { expect, it } from 'vitest';
import type { ChatSendParams } from '../../../shared/types.js';
import type { CollaborationSnapshot } from '../../../shared/collaboration.js';
import { OrdinaryContinuationService } from '../ordinaryContinuation.js';

const input: ChatSendParams = { agent: 'codex', sessionKey: 'new-key', resumeSessionId: 'native-source', projectPath: '/project', permissionMode: 'full-access', text: '核对新差异' };
const saved: CollaborationSnapshot = { id: 'run', seq: 2, createdAt: 1, params: { initiator: { ...input, sessionKey: 'old-key' }, executor: { agent: 'claude' }, objective: '原始评审目标' }, status: 'completed', stage: 'finished', deliveries: [], tasks: [{ id: 'summary', sessionKey: 'old-key', nativeSessionId: 'native-source', agent: 'codex', role: 'synthesis', status: 'succeeded' }], summary: '互审支持源码机制，未运行测试' };
const service = (runs: CollaborationSnapshot[]) => new OrdinaryContinuationService({ runs: async () => runs, drafts: async () => [] });

it('重启后的新视图 key 仍根据同一原生会话得到交接和报告参考', async () => {
  const instructions = await service([saved]).forMessage(input);
  expect(instructions).toContain('当前消息由 HCode 的普通对话入口发送');
  expect(instructions).toContain('不约束当前普通消息');
  expect(instructions).toContain('保留旧报告作为参考证据');
  expect(instructions).toContain('本轮用户明确提出的只读');
  expect(instructions).toContain('"id":"run"');
  expect(instructions).not.toContain(saved.summary);
  expect(instructions).not.toContain(saved.params.objective);
  expect(saved.tasks[0]!.status).toBe('succeeded');
});
it('旧记录缺少单回合原生 id 时仍可通过可信主持身份交接', async () => {
  expect(await service([{ ...saved, tasks: [{ ...saved.tasks[0]!, nativeSessionId: undefined }] }]).forMessage(input)).toContain('"id":"run"');
});
it('不同项目、后端、原生线程及无历史记录都不注入交接', async () => {
  for (const params of [{ ...input, projectPath: '/other' }, { ...input, agent: 'claude' as const }, { ...input, resumeSessionId: 'other-thread' }]) expect(await service([saved]).forMessage(params)).toBeUndefined();
  expect(await service([]).forMessage(input)).toBeUndefined();
});
it('不把活动协作或停止未确认的回合宣告为已经交接', async () => {
  expect(await service([{ ...saved, status: 'running' }]).forMessage(input)).toBeUndefined();
  expect(await service([{ ...saved, tasks: [{ ...saved.tasks[0]!, error: '未收到原生中断确认' }] }]).forMessage(input)).toBeUndefined();
});
it('记录读取失败明确传播，不能忽略损坏记录后冒充恢复成功', async () => {
  const failing = new OrdinaryContinuationService({ runs: async () => { throw new Error('记录读取失败'); }, drafts: async () => [] });
  await expect(failing.forMessage(input)).rejects.toThrow('记录读取失败');
});
