// ACP 原生后台任务跟踪：同步工具阻塞当前回合；若模型在工具终结前继续发言或回合结束，则晋升为后台任务继续跟踪。
import type { BackgroundTask, BackgroundTaskStatus } from "../../../shared/backgroundTasks.js";
import { isRecord, type JsonRecord } from "../rowProjectorBase.js";

const RETAINED_RESULT_LIMIT = 20;

interface ForegroundTool {
  id: string;
  description: string;
  taskType?: string;
  startedAt: number;
}

interface BackgroundRecord {
  task: BackgroundTask;
  startedAt: number;
  endedSequence?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function terminalStatus(value: unknown): BackgroundTaskStatus | undefined {
  switch (value) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "stopped";
    default:
      return undefined;
  }
}

function toolDescription(update: JsonRecord): string | undefined {
  const title = str(update.title);
  if (title) return title;
  const args = isRecord(update.args) ? update.args : isRecord(update.rawInput) ? update.rawInput : undefined;
  if (args) {
    const summary = str(args.toolSummary) ?? str(args.CommandLine) ?? str(args.Description);
    if (summary) return summary;
  }
  return str(update.name);
}

function errorSummary(update: JsonRecord): string | undefined {
  if (isRecord(update.rawOutput)) {
    const err = str(update.rawOutput.error);
    if (err) return err.slice(0, 200);
  }
  const direct = str(update.error);
  return direct ? direct.slice(0, 200) : undefined;
}

export class AgyBackgroundTasks {
  private readonly foreground = new Map<string, ForegroundTool>();
  private readonly records = new Map<string, BackgroundRecord>();
  private resultSequence = 0;

  /** 正在运行中的后台任务数量（不含仍在同步阻塞当前回合的工具）。 */
  get count(): number {
    let total = 0;
    for (const record of this.records.values()) {
      if (record.task.status === "running") total++;
    }
    return total;
  }

  /** 仍在同步阻塞当前回合的工具数量。 */
  get blockingCount(): number {
    return this.foreground.size;
  }

  /** 仍在运行中的后台任务对应的 toolCallId，供回合收尾时保留运行态而不误标取消。 */
  runningToolIds(): Set<string> {
    const ids = new Set<string>();
    for (const record of this.records.values()) {
      if (record.task.status === "running" && record.task.toolUseId) ids.add(record.task.toolUseId);
    }
    return ids;
  }

  /** 返回独立快照，已发出的 IPC 状态不会被后续事件原地修改。 */
  snapshot(): BackgroundTask[] {
    return [...this.records.values()]
      .sort((left, right) => (left.endedSequence ?? 0) - (right.endedSequence ?? 0))
      .map((record) => ({ ...record.task }));
  }

  /** 新 ACP 进程启动时清空旧进程的运行态记录。 */
  reset(): void {
    this.foreground.clear();
    this.records.clear();
    this.resultSequence = 0;
  }

  /** 取消或出错时清理当前回合的前景阻塞记录，不影响已转入后台的任务。 */
  clearForeground(): void {
    this.foreground.clear();
  }

  /** 跟踪 ACP tool_call / tool_call_update；返回后台任务面板是否有可见变化。 */
  observeTool(update: JsonRecord, now: number): { changed: boolean; terminal: boolean } {
    const id = str(update.toolCallId);
    if (!id) return { changed: false, terminal: false };
    const status = terminalStatus(update.status);
    const description = toolDescription(update);
    const taskType = str(update.name);

    if (!status) {
      const existingBg = this.records.get(id);
      if (existingBg && existingBg.task.status === "running") {
        let changed = false;
        if (description && description !== existingBg.task.description) {
          existingBg.task = { ...existingBg.task, description };
          changed = true;
        }
        if (taskType && taskType !== existingBg.task.taskType) {
          existingBg.task = { ...existingBg.task, taskType };
          changed = true;
        }
        return { changed, terminal: false };
      }
      const prev = this.foreground.get(id);
      this.foreground.set(id, {
        id,
        description: description ?? prev?.description ?? "后台任务",
        taskType: taskType ?? prev?.taskType,
        startedAt: prev?.startedAt ?? now,
      });
      return { changed: false, terminal: false };
    }

    this.foreground.delete(id);
    const existingBg = this.records.get(id);
    if (!existingBg) return { changed: false, terminal: true };
    const summary = status === "failed" ? errorSummary(update) : undefined;
    existingBg.task = {
      ...existingBg.task,
      ...(description ? { description } : {}),
      ...(taskType ? { taskType } : {}),
      status,
      durationMs: Math.max(0, now - existingBg.startedAt),
      ...(summary ? { summary } : {}),
    };
    this.trimResults();
    return { changed: true, terminal: true };
  }

  /** 将尚未终结的前景工具晋升为后台任务（模型已继续发言或当前回合已结束）。 */
  promoteActiveToBackground(): boolean {
    if (this.foreground.size === 0) return false;
    let changed = false;
    for (const tool of this.foreground.values()) {
      const existing = this.records.get(tool.id);
      if (existing) {
        if (existing.task.status !== "running") continue;
        existing.task = {
          ...existing.task,
          description: tool.description,
          ...(tool.taskType ? { taskType: tool.taskType } : {}),
        };
      } else {
        this.records.set(tool.id, {
          startedAt: tool.startedAt,
          task: {
            id: tool.id,
            toolUseId: tool.id,
            description: tool.description,
            ...(tool.taskType ? { taskType: tool.taskType } : {}),
            status: "running",
          },
        });
        changed = true;
      }
    }
    this.foreground.clear();
    if (changed) this.trimResults();
    return changed;
  }

  /** ACP 进程退出或关闭时将仍运行的后台任务标记为连接已结束。 */
  endProcess(): boolean {
    this.foreground.clear();
    let changed = false;
    for (const record of this.records.values()) {
      if (record.task.status !== "running") continue;
      record.task = { ...record.task, status: "interrupted" };
      changed = true;
    }
    if (changed) this.trimResults();
    return changed;
  }

  private trimResults(): void {
    const finished = [...this.records.values()].filter((record) => record.task.status !== "running");
    for (const record of finished) record.endedSequence ??= ++this.resultSequence;
    finished.sort((left, right) => left.endedSequence! - right.endedSequence!);
    for (const record of finished.slice(0, -RETAINED_RESULT_LIMIT)) {
      this.records.delete(record.task.id);
    }
  }
}
