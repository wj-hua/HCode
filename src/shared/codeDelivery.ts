// 隔离代码交付的公开数据；模型接受与用户采纳分别记录。
import type { AdoptionState } from "./codeAdoption.js";
export const CODE_WORKSPACE_LIMITS = { maxFiles: 100_000, maxBytes: 4 * 1024 ** 3, maxWriteBytes: 256 * 1024, maxLogBytes: 512 * 1024, checkTimeoutMs: 5 * 60_000, stopTimeoutMs: 10_000 } as const;
export type ValidationCheckId = 'node-test' | 'typecheck' | 'test' | 'build';
export interface ValidationCheck { id: ValidationCheckId; executable: string; args: string[]; description: string; scripts?: Record<string, string> }
export interface CodeAdmission { hash: string; fileCount: number; bytes: number; checks: ValidationCheck[]; gitStatus: string; sourceRevision: string; strategy: 'full-copy' }
export const PARALLEL_CODE_LIMITS = { maxTasks: 2, maxPaths: 40 } as const;
export interface CodeWriteTask {
  requestKey: string;
  objective: string;
  executor: { agent: 'claude' | 'codex'; model?: string };
  allowedPaths: string[];
}
export interface CodeStartOptions { admissionHash: string; checks: ValidationCheckId[]; tasks?: CodeWriteTask[] }
export interface CodeWorkspace { id: string; runId?: string; path: string; originalPath: string; baselineHash: string; admission: CodeAdmission; state: 'candidate' | 'manual' | 'discarded' }
export interface CandidateChange { path: string; kind: 'added' | 'modified' | 'deleted'; binary: boolean; beforeHash?: string; afterHash?: string; beforeMode?: number; afterMode?: number }
export interface CodeVersion { id: string; version: number; hash: string; changes: CandidateChange[] }
export interface ValidationResult { checkId: ValidationCheckId; command: string; versionId: string; versionHash: string; exitCode: number | null; status: 'passed' | 'failed' | 'interrupted'; stdout: string; stderr: string; logTruncated: boolean }
export interface CodeDeliveryState { allowedPaths?: string[]; adoption?: AdoptionState; stopUnconfirmed?: boolean; workspace: CodeWorkspace; versions: CodeVersion[]; validations: ValidationResult[]; phase: 'execution' | 'validation' | 'review' | 'candidate' | 'manual' | 'discarded' }
export interface CandidatePreview { version: CodeVersion; changes: { path: string; before: string | null; after: string | null; binary: boolean }[] }
