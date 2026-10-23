// 验证 SDK 事件边界上的后台任务生命周期，不依赖模型或实际命令执行。
import { expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeBackgroundTasks } from '../claude/claudeBackgroundTasks.js';

type TaskMessage = Extract<SDKMessage, { subtype: 'background_tasks_changed' | 'task_started' | 'task_progress' | 'task_notification' | 'task_updated' }>;
function event(message: TaskMessage extends infer Message ? Message extends TaskMessage ? Omit<Message, 'uuid' | 'session_id' | 'type'> : never : never): SDKMessage {
  return { ...message, type: 'system', uuid: '00000000-0000-0000-0000-000000000001', session_id: 'session' };
}
const task = (id: string) => ({ task_id: id, task_type: 'local_bash', description: `测试 ${id}` });
const snapshot = (...ids: string[]) => event({ subtype: 'background_tasks_changed', tasks: ids.map(task) });
const started = (id: string) => event({ subtype: 'task_started', ...task(id), tool_use_id: `tool-${id}`, is_backgrounded: true });
const completed = (id: string, status: 'completed' | 'failed' | 'stopped' = 'completed') => event({ subtype: 'task_notification', task_id: id, status, output_file: `/tmp/${id}.log`, summary: `结果 ${id}` });

it('快照提供真实运行列表，进度补齐详情，主回合结束不会清空后台任务', () => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.consume(snapshot('test'));
  tasks.consume(started('test'));
  tasks.consume(event({ subtype: 'task_progress', task_id: 'test', description: '全量测试', summary: '执行 UI 测试', usage: { total_tokens: 10, tool_uses: 2, duration_ms: 3000 } }));
  tasks.consume({ type: 'result' } as SDKMessage);
  expect(tasks.count).toBe(1);
  expect(tasks.snapshot()).toEqual([expect.objectContaining({ id: 'test', description: '全量测试', status: 'running', summary: '执行 UI 测试', toolUseId: 'tool-test', durationMs: 3000 })]);
});

it.each(['completed', 'failed', 'stopped'] as const)('并行任务 %s 后保留结果，另一任务继续运行', status => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.consume(snapshot('first', 'second'));
  tasks.consume(completed('first', status));
  tasks.consume(snapshot('second'));
  expect(tasks.count).toBe(1);
  expect(tasks.snapshot()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'first', status, summary: '结果 first', outputFile: '/tmp/first.log' }),
    expect.objectContaining({ id: 'second', status: 'running' }),
  ]));
});

it('快照先移除任务时只报告已结束，等待明确结果；迟到进度不能恢复运行', () => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.consume(snapshot('test'));
  tasks.consume(snapshot());
  expect(tasks.count).toBe(0);
  expect(tasks.snapshot()[0]?.status).toBe('ended');
  tasks.consume(completed('test', 'failed'));
  tasks.consume(started('test'));
  expect(tasks.snapshot()[0]?.status).toBe('failed');
});

it('完成通知先于首次快照时仍保留结果，重复快照不会丢失详情', () => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.consume(completed('test'));
  tasks.consume(snapshot());
  expect(tasks.snapshot()[0]?.status).toBe('completed');
  tasks.consume(snapshot('second'));
  tasks.consume(started('second'));
  tasks.consume(snapshot('second'));
  expect(tasks.snapshot().find(item => item.id === 'second')?.toolUseId).toBe('tool-second');
});

it('先收到空快照时，迟到的开始事件不能恢复运行指示', () => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.consume(snapshot());
  tasks.consume(started('test'));
  expect(tasks.snapshot()[0]?.status).toBe('ended');
  expect(tasks.count).toBe(0);
  tasks.consume(snapshot('test'));
  expect(tasks.snapshot()[0]?.status).toBe('running');
});

it('前台任务与常驻监视不展示；切到后台后展示，ambient 变化后移除', () => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.consume(event({ subtype: 'task_started', ...task('foreground'), is_backgrounded: false }));
  tasks.consume(event({ subtype: 'task_started', ...task('completed-foreground'), is_backgrounded: false }));
  tasks.consume(completed('completed-foreground'));
  tasks.consume(event({ subtype: 'background_tasks_changed', tasks: [{ ...task('watch'), ambient: true }] }));
  expect(tasks.snapshot()).toEqual([]);
  tasks.consume(snapshot('foreground'));
  expect(tasks.snapshot()[0]?.status).toBe('running');
  tasks.consume(event({ subtype: 'background_tasks_changed', tasks: [{ ...task('foreground'), ambient: true }] }));
  tasks.consume(event({ subtype: 'task_notification', task_id: 'foreground', status: 'stopped', output_file: '', summary: '', ambient: true }));
  expect(tasks.snapshot()).toEqual([]);
  expect(tasks.count).toBe(0);
});

it('原生错误与停止更新立即生效，进程退出不会伪造成功，新进程不继承旧活动状态', () => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.consume(snapshot('first', 'second'));
  tasks.consume(event({ subtype: 'task_updated', task_id: 'first', patch: { status: 'failed', error: '构建失败' } }));
  expect(tasks.snapshot()[0]).toMatchObject({ status: 'failed', summary: '构建失败' });
  tasks.endProcess();
  expect(tasks.count).toBe(0);
  expect(tasks.snapshot()[1]?.status).toBe('interrupted');
  expect(tasks.snapshot()[0]?.status).toBe('failed');
  tasks.reset();
  expect(tasks.snapshot()).toEqual([]);
});

it('只裁剪旧的结束结果，长任务最后完成时仍保留为最新结果', () => {
  const tasks = new ClaudeBackgroundTasks();
  tasks.consume(snapshot('long'));
  for (let index = 0; index < 25; index++) {
    const id = `short-${index}`;
    tasks.consume(snapshot('long', id));
    tasks.consume(completed(id));
    tasks.consume(snapshot('long'));
  }
  expect(tasks.snapshot()).toHaveLength(21);
  tasks.consume(completed('long'));
  tasks.consume(snapshot());
  expect(tasks.snapshot()).toHaveLength(20);
  expect(tasks.snapshot().at(-1)).toMatchObject({ id: 'long', status: 'completed' });
});
