// 用户采纳与 AI 交付分离；预览 token 绑定所选版本及当时的全部冲突信号。
import type { CandidatePreview } from "./codeDelivery.js";
export const ADOPTION_LOCK_DIRECTORY = ".hcode-apply-lock";
export interface AdoptionRequest {
  versionId: string;
  previewHash: string;
}
export type AdoptionStatus =
  "prepared" | "applying" | "applied" | "needsRecovery" | "rolledBack";
export interface AdoptionState {
  id: string;
  runId: string;
  workspaceId?: string;
  versionId: string;
  versionHash: string;
  previewHash: string;
  status: AdoptionStatus;
  cleanupPending: boolean;
  createdAt: number;
  updatedAt: number;
  changedPaths: string[];
  error?: string;
}
export interface AdoptionConflict {
  path: string;
  reason: string;
}
export interface AdoptionPreview extends CandidatePreview {
  hash: string;
  eligible: boolean;
  reasons: string[];
  conflicts: AdoptionConflict[];
  originalPath: string;
  adoption?: AdoptionState;
}
export function adoptionBlocksEdits(state?: AdoptionState) {
  return Boolean(
    state && (state.status !== "rolledBack" || state.cleanupPending),
  );
}
