// 原生后台工作的运行期快照；不从模型文本猜测执行状态，也不作为持久化任务历史。
export type BackgroundTaskStatus = 'running' | 'ended' | 'completed' | 'failed' | 'stopped' | 'interrupted';

export interface BackgroundTask {
  id: string;
  description: string;
  status: BackgroundTaskStatus;
  taskType?: string;
  toolUseId?: string;
  summary?: string;
  outputFile?: string;
  durationMs?: number;
}

export const BACKGROUND_TASK_STATUS_LABELS: Record<BackgroundTaskStatus, string> = {
  running: '运行中',
  ended: '已结束，等待结果',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  interrupted: '连接已结束，结果未知',
};
