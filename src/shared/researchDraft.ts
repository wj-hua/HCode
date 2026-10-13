// U0 单项只读计划；草案和已执行 Run 使用独立状态，不接受代码或专家配置。
import type { CollaborationStartParams, CollaborationTask } from "./collaboration.js";
export type ResearchDraftInput = Omit<CollaborationStartParams, "mode" | "code">;
export interface ResearchDraftEdit {
  objective: string;
  executor: ResearchDraftInput["executor"];
  reviewer?: ResearchDraftInput["reviewer"];
}
export interface DraftFile { path: string; hash: string }
export interface ResearchDraft {
  id: string;
  revision: number;
  createdAt: number;
  status: "editing" | "preparing" | "ready" | "blocked" | "cancelled" | "abandoned" | "starting" | "started";
  params: ResearchDraftInput;
  summary?: string;
  sources: DraftFile[];
  turns: CollaborationTask[];
  error?: string;
  rawResult?: string;
  approvalHash?: string;
  runId?: string;
}
export interface ApprovedResearchPlan {
  draftId: string;
  revision: number;
  hash: string;
}
