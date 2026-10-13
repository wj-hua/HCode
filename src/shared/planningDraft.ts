// 计划的公共生命周期；业务分工分别由只读、专家和代码计划定义，Run 不属于草案状态。
import type { CollaborationStartParams, CollaborationTask, CollaborationCapabilities } from "./collaboration.js";
export interface PlanningCapability extends Pick<CollaborationCapabilities, 'agent' | 'version' | 'canInitiate' | 'canExecute' | 'canReview' | 'canExecuteCode'> { models: string[] }
export interface DraftFile { path: string; hash: string }
export interface PlanningDraftParams { initiator: CollaborationStartParams["initiator"]; objective: string }
export interface PlanningDraft<P extends PlanningDraftParams = PlanningDraftParams> {
  id: string;
  revision: number;
  createdAt: number;
  status: "editing" | "preparing" | "ready" | "blocked" | "cancelled" | "abandoned" | "starting" | "started";
  params: P;
  summary?: string;
  sources: DraftFile[];
  turns: CollaborationTask[];
  error?: string;
  rawResult?: string;
  approvalHash?: string;
  runId?: string;
}
