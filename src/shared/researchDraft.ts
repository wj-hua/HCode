// U0 单项只读计划；草案和已执行 Run 使用独立状态，不接受代码或专家配置。
import type { PlanningDraft } from "./planningDraft.js";
import type { CollaborationStartParams } from "./collaboration.js";
export type ResearchDraftInput = Omit<CollaborationStartParams, "mode" | "code">;
export interface ResearchDraftEdit {
  objective: string;
  executor: ResearchDraftInput["executor"];
  reviewer?: ResearchDraftInput["reviewer"];
}
export type { DraftFile } from "./planningDraft.js";
export interface ResearchDraft extends PlanningDraft<ResearchDraftInput> {}
export interface ApprovedResearchPlan {
  draftId: string;
  revision: number;
  hash: string;
}
