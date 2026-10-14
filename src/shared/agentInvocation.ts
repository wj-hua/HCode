// 普通会话工具调用的记录；提示词来自主 AI，原生终态与展示状态分开。
import type { ChatSendParams, ChatUsage } from './types.js';
export const INVOCATION_LIMITS = { maxPromptLength: 24_000, maxCallsPerTurn: 8 } as const;
export const CALL_AGENT_TOOL = 'call_agent';
export type InvocationAgent = 'claude' | 'codex';
export interface AgentInvocationInput {
  agent: InvocationAgent;
  prompt: string;
  mode: 'read-only' | 'execute';
  model?: string;
  continueInvocationId?: string;
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
}
export function invocationBelongsToSource(call: AgentInvocation, source: { agent: string; projectPath: string; sessionKey?: string; sessionId?: string }) {
  return call.source.agent === source.agent && call.source.projectPath === source.projectPath &&
    (call.source.sessionKey === source.sessionKey || Boolean(source.sessionId && call.source.resumeSessionId === source.sessionId));
}
