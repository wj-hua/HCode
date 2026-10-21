// 仅监听 loopback 的会话级 MCP，凭临时令牌绑定宿主运行时；不读取全局配置或信任模型路径。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { researchTools, type ResearchRuntime } from '../../sessions/researchRuntime.js';
import { isScopedWriteTool } from '../../sessions/scopedFileWriter.js';
const MAX_CALLS_PER_TURN = 128;
const MCP_PROTOCOL_VERSION = "2024-11-05";
const MAX_REQUEST_BYTES = 256 * 1024;
const LOOPBACK_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';
const requestSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(), method: z.string(), params: z.unknown().optional() });
const callSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()), _meta: z.record(z.string(), z.unknown()).optional() }).strict();
const ALLOWED_RESEARCH_TOOLS = new Set(['read_file', 'list_files', 'request_context', 'read_baseline_file', 'read_expert_resource']);
const toolFailure = (error: unknown) => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] });

export class AgyResearchBridge {
  private readonly token = randomBytes(32).toString('hex');
  private readonly server = createServer((request, response) => { void this.handle(request, response); });
  private scope?: { runtime: ResearchRuntime };
  private readonly calls = new Map<string | number, { input: z.infer<typeof callSchema>; result: Promise<unknown> }>();
  private origin = '';
  get config() { return { name: 'hcode', serverUrl: this.origin + MCP_PATH, headers: { Authorization: `Bearer ${this.token}` } }; }

  async listen() {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, LOOPBACK_HOST, () => { this.server.off('error', reject); resolve(); }); });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('HCode agy MCP 未建立本地端口');
    this.origin = `http://${LOOPBACK_HOST}:${address.port}`;
  }
  /** 仅准入只读工具和宿主签发的文件范围写入闭包；任意同名工具不能取得写权限。 */
  begin(runtime: ResearchRuntime) {
    if (researchTools(runtime).some(tool => !ALLOWED_RESEARCH_TOOLS.has(tool.name) && !isScopedWriteTool(tool))) throw new Error('agy 未开放非宿主授权的写入工具或自主委派');
    this.scope = { runtime }; this.calls.clear();
  }
  stop() { this.scope = undefined; this.calls.clear(); }
  close() { this.stop(); this.server.close(); this.server.closeAllConnections(); }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.host !== new URL(this.origin).host || request.headers.authorization !== `Bearer ${this.token}` || request.url !== MCP_PATH || request.headers.origin && request.headers.origin !== this.origin) { response.writeHead(401).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let id: string | number | undefined;
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > MAX_REQUEST_BYTES) throw new Error('MCP 请求超过大小限制'); chunks.push(chunk); }
      const input = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); id = input.id;
      if (input.method === 'notifications/initialized' || input.method === 'notifications/cancelled') { response.writeHead(202).end(); return; }
      if (id === undefined) throw new Error('MCP 请求缺少 id');
      const result = await this.dispatch(input.method, input.params, id);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (error) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: error instanceof Error ? error.message : String(error) } }));
    }
  }
  private async dispatch(method: string, params: unknown, id: string | number): Promise<unknown> {
    if (method === 'initialize') return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'hcode', version: '1.0.0' } };
    const scope = this.scope;
    if (!scope) throw new Error('本次 agy 宿主工具作用域已结束');
    if (method === 'tools/list') return { tools: researchTools(scope.runtime).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(z.object(tool.schema).strict(), { target: 'draft-7' }), annotations: { readOnlyHint: tool.name !== 'request_context' && !isScopedWriteTool(tool), destructiveHint: tool.name === 'delete_file', openWorldHint: false }, _meta: { 'antigravity/alwaysLoad': true } })) };
    if (method !== 'tools/call') throw new Error(`未支持的 MCP 方法：${method}`);
    const input = callSchema.parse(params), previous = this.calls.get(id);
    if (previous) return isDeepStrictEqual(previous.input, input) ? previous.result : toolFailure('重复 MCP 请求 id 与参数冲突');
    if (this.calls.size >= MAX_CALLS_PER_TURN) return toolFailure("当前回合 MCP 工具调用超过上限");
    const result = this.call(scope, input);
    this.calls.set(id, { input, result });
    return result;
  }
  private async call(scope: { runtime: ResearchRuntime }, input: z.infer<typeof callSchema>) {
    try {
      const tool = researchTools(scope.runtime).find((entry) => entry.name === input.name);
      if (!tool) throw new Error('未授权的 agy 宿主工具');
      const value = await tool.execute(z.object(tool.schema).strict().parse(input.arguments));
      if (this.scope !== scope) throw new Error('agy 宿主工具已取消，迟到结果不回传');
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) { return toolFailure(error); }
  }
}
