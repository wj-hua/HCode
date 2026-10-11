// 只归一原生 result；结构化答案与展示正文分开，拒绝操作不记作成功。
import { z } from 'zod';
import type { TurnOutcome } from '../../../shared/collaboration.js';
const resultSchema = z.object({ conversation_id: z.string().min(1), num_turns: z.number().int().positive(), status: z.string(), response: z.string(), structured_output: z.unknown().optional(), error: z.string().optional(), denied_actions: z.array(z.unknown()).optional() }).passthrough();
export function agyResult(input: unknown, nativeId: string | undefined) {
  const result = resultSchema.parse(input);
  if (result.conversation_id !== nativeId) throw new Error('agy 结果不属于当前原生会话');
  const denied = result.denied_actions ?? [];
  let outcome: TurnOutcome['outcome'] = 'succeeded', error: string | undefined;
  if (result.error === 'interrupted') outcome = 'interrupted';
  else if (result.status !== 'SUCCESS' || result.error) { outcome = 'failed'; error = result.error || `agy 未提供成功终态：${result.status}`; }
  else if (denied.length) { outcome = 'failed'; error = `agy 无头权限拒绝：${JSON.stringify(denied)}`; }
  return { result, outcome, error, text: result.structured_output !== undefined ? JSON.stringify(result.structured_output) : result.response };
}
