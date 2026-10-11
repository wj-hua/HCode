// 主进程活动 Run 的资源归属；落盘快照与运行中的 Promise/AbortController 分离。
import type { CollaborationSnapshot } from "../../shared/collaboration.js";
import type { RunExecutor } from "./runExecutor.js";
import type { TaskMessages } from "./taskMessages.js";

export interface ActiveRun {
  snapshot: CollaborationSnapshot;
  executor: RunExecutor;
  messages: TaskMessages;
  jobs: Map<string, Promise<void>>;
  writes: Promise<void>;
  done?: Promise<void>;
}
