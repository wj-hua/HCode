// 普通会话工具调用的记录；提示词来自主 AI，原生终态与展示状态分开。
import type { ChatSendParams, ChatUsage } from './types.js';
import type { ScopedWriteFeedback } from './codeDelivery.js';
export const INVOCATION_LIMITS = { maxPromptLength: 24_000, maxCallsPerTurn: 8, maxParallelTasks: 2, maxWritePaths: 40 } as const;
export const CALL_AGENT_TOOL = 'call_agent';
export const CALL_AGENTS_TOOL = 'call_agents';
export const LIST_AGENT_TARGETS_TOOL = 'list_agent_targets';
export const INVOCATION_AGENTS = ['claude', 'codex', 'agy'] as const;
export type InvocationAgent = typeof INVOCATION_AGENTS[number];
export interface AgentInvocationInput {
  agent: InvocationAgent;
  prompt: string;
  mode: 'read-only' | 'execute';
  model?: string;
  continueInvocationId?: string;
}
export interface ParallelInvocationTask {
  taskKey: string;
  agent: InvocationAgent;
  prompt: string;
  model?: string;
  allowedPaths: string[];
}
export interface InvocationWriteScope {
  batchId: string;
  taskKey: string;
  allowedPaths: string[];
}
export interface AgentInvocation {
  id: string;
  seq: number;
  createdAt: number;
  source: Omit<ChatSendParams, 'text' | 'images' | 'files'>;
  sourceTurnId: string;
  input: AgentInvocationInput;
  sessionKey: string;
  nativeSessionId?: string;
  status: 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  output?: string;
  error?: string;
  usage?: ChatUsage;
  writeScope?: InvocationWriteScope;
  writeFeedback?: ScopedWriteFeedback[];
}
export function invocationBelongsToSource(call: AgentInvocation, source: { agent: string; projectPath: string; sessionKey?: string; sessionId?: string }) {
  return call.source.agent === source.agent && call.source.projectPath === source.projectPath &&
    (call.source.sessionKey === source.sessionKey || Boolean(source.sessionId && call.source.resumeSessionId === source.sessionId));
}
