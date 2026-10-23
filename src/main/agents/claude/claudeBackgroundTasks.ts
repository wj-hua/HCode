// SDK 后台任务状态归并：活动数量只取完整快照，边沿事件补详情和结果，避免漏通知导致永久转圈。
import type { SDKMessage, SDKBackgroundTasksChangedMessage, SDKTaskUpdatedMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BackgroundTask, BackgroundTaskStatus } from '../../../shared/backgroundTasks.js';

const RETAINED_RESULT_LIMIT = 20;
const UPDATED_STATUS: Partial<Record<NonNullable<SDKTaskUpdatedMessage['patch']['status']>, BackgroundTaskStatus>> = {
  completed: 'completed', failed: 'failed', killed: 'stopped',
};
interface TaskRecord {
  task: BackgroundTask;
  visible: boolean;
  endedSequence?: number;
}

export class ClaudeBackgroundTasks {
  private readonly records = new Map<string, TaskRecord>();
  private activeIds = new Set<string>();
  private receivedSnapshot = false;
  private resultSequence = 0;

  get count(): number { return this.activeIds.size; }

  /** 返回独立快照，已发出的 IPC 状态不会随后续事件被原地修改。 */
  snapshot(): BackgroundTask[] {
    return [...this.records.values()].filter(record => record.visible)
      .sort((left, right) => (left.endedSequence ?? 0) - (right.endedSequence ?? 0))
      .map(record => ({ ...record.task }));
  }

  /** 新 CLI 进程没有可继承的活动快照。历史工具输出不用于恢复运行态。 */
  reset(): void {
    this.records.clear();
    this.activeIds.clear();
    this.receivedSnapshot = false;
    this.resultSequence = 0;
  }

  /** 进程退出不等于外部命令成功或被杀死；保留结果未知的记录供核对。 */
  endProcess(): boolean {
    let changed = this.activeIds.size > 0;
    this.activeIds.clear();
    for (const record of this.records.values()) {
      if (record.task.status !== 'running' && record.task.status !== 'ended') continue;
      record.task = { ...record.task, status: 'interrupted' };
      changed = true;
    }
    this.trimResults();
    return changed;
  }

  /** 消费原生事件；前台任务先缓存关联，只有后台快照或明确后台标志才展示。 */
  consume(message: SDKMessage): boolean {
    if (message.type !== 'system') return false;
    switch (message.subtype) {
      case 'background_tasks_changed':
        this.replaceActive(message);
        break;
      case 'task_started': {
        const record = this.record(message.task_id);
        record.task = { ...record.task, description: message.description, taskType: message.task_type, toolUseId: message.tool_use_id };
        if (message.ambient || message.skip_transcript) record.visible = false;
        else if (message.is_backgrounded) record.visible = true;
        break;
      }
      case 'task_progress': {
        const record = this.record(message.task_id);
        record.task = { ...record.task, description: message.description, toolUseId: message.tool_use_id ?? record.task.toolUseId,
          durationMs: message.usage.duration_ms,
          ...(record.task.status === 'running' && message.summary ? { summary: message.summary } : {}),
        };
        break;
      }
      case 'task_notification': {
        const previouslyVisible = this.records.get(message.task_id)?.visible;
        const record = this.record(message.task_id);
        // 已知前台任务和常驻任务不能仅因结束通知而出现在后台面板。
        record.visible = !message.ambient && !message.skip_transcript && previouslyVisible !== false;
        record.task = { ...record.task, status: message.status, summary: message.summary, outputFile: message.output_file,
          toolUseId: message.tool_use_id ?? record.task.toolUseId, durationMs: message.usage?.duration_ms ?? record.task.durationMs };
        break;
      }
      case 'task_updated': {
        const record = this.record(message.task_id);
        const patch = message.patch;
        if (patch.is_backgrounded) record.visible = true;
        record.task = { ...record.task, description: patch.description ?? record.task.description,
          status: (patch.status && UPDATED_STATUS[patch.status]) || record.task.status,
          summary: patch.error ?? record.task.summary };
        break;
      }
      default: return false;
    }
    this.trimResults();
    return true;
  }

  private record(id: string): TaskRecord {
    const existing = this.records.get(id);
    if (existing) return existing;
    const status = this.receivedSnapshot && !this.activeIds.has(id) ? 'ended' : 'running';
    const record: TaskRecord = { task: { id, description: '后台任务', status }, visible: false };
    this.records.set(id, record);
    return record;
  }

  private replaceActive(message: SDKBackgroundTasksChangedMessage): void {
    this.receivedSnapshot = true;
    const active = message.tasks.filter(task => !task.ambient);
    this.activeIds = new Set(active.map(task => task.task_id));
    for (const record of this.records.values()) {
      if (record.visible && record.task.status === 'running' && !this.activeIds.has(record.task.id)) {
        record.task = { ...record.task, status: 'ended' };
      }
    }
    for (const task of message.tasks) {
      const record = this.record(task.task_id);
      record.visible = !task.ambient;
      // 完成通知与快照没有顺序保证；已经明确的终态不能被快照或迟到的开始事件覆盖。
      const status = record.task.status === 'ended' ? 'running' : record.task.status;
      record.task = { ...record.task, description: task.description, taskType: task.task_type, status };
    }
  }

  private trimResults(): void {
    const finished = [...this.records.values()].filter(record => !this.activeIds.has(record.task.id) && record.task.status !== 'running');
    // 按结束顺序保留结果，先启动的长任务不能在刚完成时被当作最旧记录移除。
    for (const record of finished) record.endedSequence ??= ++this.resultSequence;
    finished.sort((left, right) => left.endedSequence! - right.endedSequence!);
    for (const record of finished.slice(0, -RETAINED_RESULT_LIMIT)) this.records.delete(record.task.id);
  }
}
