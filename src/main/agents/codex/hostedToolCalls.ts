// 宿主动态工具请求按原生 thread/turn/call 绑定，重复请求共用一次执行，取消后不回传迟到结果。
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { ServerRequest } from './appServerClient.js';
import type { ResearchRuntime } from '../../sessions/researchRuntime.js';
import { callResearchTool } from './researchTools.js';
const MAX_CALLS_PER_TURN = 128;
type ToolResult = Awaited<ReturnType<typeof callResearchTool>>;
const paramsSchema = z.object({ threadId: z.string().min(1), turnId: z.string().min(1), callId: z.string().min(1), tool: z.string().min(1), namespace: z.string().nullable().optional(), arguments: z.unknown() }).strict();
function failed(message: string): ToolResult { return { success: false, contentItems: [{ type: 'inputText', text: message }] }; }
interface ToolReplyHost { respond(id: string | number, result: ToolResult): void; failure(error: unknown): void }
export class HostedToolCalls {
  private scope?: { threadId: string; turnId: string; runtime: ResearchRuntime };
  private readonly calls = new Map<string, { params: z.infer<typeof paramsSchema>; result: Promise<ToolResult> }>();
  private readonly requests = new Map<string | number, { callId: string; replied: boolean }>();
  constructor(private readonly host: ToolReplyHost) {}
  begin(threadId: string, turnId: string, runtime: ResearchRuntime) {
    if (this.scope?.turnId === turnId) return;
    this.cancel(); this.calls.clear(); this.requests.clear(); this.scope = { threadId, turnId, runtime };
  }
  handle(request: ServerRequest) {
    const parsed = paramsSchema.safeParse(request.params), scope = this.scope;
    if (!parsed.success || !scope || parsed.data.threadId !== scope.threadId || parsed.data.turnId !== scope.turnId) {
      this.host.respond(request.id, failed('工具调用不属于当前会话和回合，或参数无效')); return;
    }
    const params = parsed.data, previousRequest = this.requests.get(request.id), previous = this.calls.get(params.callId);
    if (previousRequest?.callId === params.callId && previous && isDeepStrictEqual(previous.params, params)) return;
    if (previousRequest || previous && !isDeepStrictEqual(previous.params, params)) { if (previousRequest) previousRequest.replied = true; this.host.respond(request.id, failed('重复工具请求身份与参数冲突')); return; }
    if (!previous && this.calls.size >= MAX_CALLS_PER_TURN) { this.host.respond(request.id, failed('当前回合宿主工具调用超过上限')); return; }
    const entry = { callId: params.callId, replied: false };
    this.requests.set(request.id, entry);
    const call = previous ?? { params, result: callResearchTool(scope.runtime, params) };
    if (!previous) this.calls.set(params.callId, call);
    void call.result.then((result) => {
      if (entry.replied || this.scope !== scope) return;
      entry.replied = true; this.host.respond(request.id, result);
    }).catch((error: unknown) => { if (this.scope === scope) this.host.failure(error); });
  }
  /** 先终止宿主等待，再由 Session 请求原生中断；不把中断发送成功当作回合结束。 */
  cancel() {
    this.scope = undefined;
    for (const [id, entry] of this.requests) {
      if (entry.replied) continue;
      entry.replied = true; this.host.respond(id, failed('宿主工具等待已取消，迟到结果不再回传'));
    }
  }
}
