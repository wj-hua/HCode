// 协作与原生回合的公开契约；执行成功、交付接受和用户采纳各自独立。
import type { CodeStartOptions, CodeDeliveryState } from "./codeDelivery.js";
import type { ExpertStartParams, ExpertState } from './experts.js';
import type { AgentKind, ChatUsage, ChatSendParams, ModelOption } from "./types.js";

export const COLLABORATION_LIMITS = { maxTurns: 12, maxConcurrentWorkers: 2, maxDeliveries: 6, maxRevisions: 2, maxContextLength: 8000, maxMessages: 40 } as const;
export const COLLABORATION_SOURCE_TOOL_NAMES = ['get_context_requests', 'reply_context', 'delegate_task', 'get_task_result', 'wait_tasks'] as const;
export interface CollaborationSource { agent: AgentKind; resumeSessionId?: string }

export type TurnResult = "succeeded" | "failed" | "cancelled" | "interrupted";
export interface TurnOutcome {
  sessionKey: string;
  agent: AgentKind;
  executionTurnId: string;
  nativeTurnId?: string;
  nativeSessionId?: string;
  outcome: TurnResult;
  text: string;
  error?: string;
  usage?: ChatUsage;
}

export const COLLABORATION_WORKER_AGENTS = ["claude", "codex", "agy"] as const;
export type CollaborationWorkerAgent = typeof COLLABORATION_WORKER_AGENTS[number];
export interface CollaborationBackend { agent: CollaborationWorkerAgent; model?: string }

export interface CollaborationStartParams {
  mode?: 'delegation';
  initiator: Omit<ChatSendParams, "text" | "images" | "files">;
  executor: CollaborationBackend;
  reviewer?: CollaborationBackend;
  objective: string;
  code?: CodeStartOptions;
}

export interface SourceEvidence {
  path: string;
  startLine: number;
  endLine: number;
  quote: string;
  hash: string;
}

export interface ReportVersion {
  id: string;
  version: number;
  hash: string;
  summary: string;
  evidence: SourceEvidence[];
}

export interface ReviewIssue {
  id: string;
  blocking: boolean;
  location: string;
  reason: string;
  evidence: string;
  suggestion: string;
}

export interface DeliveryReview {
  reviewer?: { agent: AgentKind; sessionKey: string; nativeSessionId?: string };
  versionId: string;
  verdict: "approved" | "changesRequested" | "inconclusive";
  summary: string;
  issues: ReviewIssue[];
}

export interface DeliverySnapshot {
  id: string;
  requestKey: string;
  objective: string;
  executor: CollaborationStartParams["executor"];
  status: "queued" | "executing" | "reviewing" | "revising" | "accepted" | "failed" | "awaitingUser" | "cancelled" | "interrupted";
  versions: ReportVersion[];
  reviews: DeliveryReview[];
  error?: string;
  workerSessionKey?: string;
}

export interface CollaborationTask {
  id: string;
  deliveryId?: string;
  expertId?: string;
  sessionKey: string;
  agent: CollaborationWorkerAgent;
  model?: string;
  role: "planning" | "execution" | "review" | "synthesis";
  status: "running" | TurnResult;
  nativeSessionId?: string;
  error?: string;
  usage?: ChatUsage;
}

export interface TaskMessage {
  id: string;
  deliveryId: string;
  requestKey: string;
  sender: "worker" | "initiator" | "user";
  recipient: "initiator" | "worker";
  type: "clarification" | "answer" | "context";
  text: string;
  createdAt: number;
  requiresUser?: boolean;
  replyTo?: string;
}

export interface CollaborationResumeParams {
  deliveryId?: string;
  action: "execute" | "review";
  context?: string;
}

export interface RecoveryIssue { runId: string; error: string; canRepairTail: boolean }

export interface CollaborationSnapshot {
  id: string;
  seq: number;
  createdAt: number;
  params: CollaborationStartParams | ExpertStartParams;
  status: "running" | "stopping" | "paused" | "awaitingUser" | "completed" | "failed" | "cancelled" | "interrupted";
  stage: "planning" | "awaitingWorkers" | "expertResearch" | "peerReview" | "synthesis" | "finished";
  tasks: CollaborationTask[];
  deliveries: DeliverySnapshot[];
  summary?: string;
  error?: string;
  persistenceError?: string;
  stopIntent?: "pause" | "cancel";
  messages?: TaskMessage[];
  code?: CodeDeliveryState;
  experts?: ExpertState;
}

export interface CollaborationCapabilities {
  agent: AgentKind;
  canExecute: boolean;
  canInitiate: boolean;
  canReview: boolean;
  canExecuteCode: boolean;
  models?: ModelOption[];
  reason: string;
  version?: string;
}
