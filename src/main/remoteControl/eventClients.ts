// 远程事件连接：内容按连接声明的会话范围过滤，运行状态与审批始终送达。
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EventChannel, EventMap } from "../../shared/ipc.js";

const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_VIEWED_SESSIONS = 16;
const MAX_KEY_LENGTH = 256;
interface Client { keys: Set<string> | null }

export class RemoteEventClients {
  private readonly clients = new Map<ServerResponse, Client>();
  constructor(private readonly changed: () => void) {}
  get size(): number { return this.clients.size; }

  /** 无 clientId 的旧客户端继续接收完整流；新客户端显式声明当前查看的会话。 */
  open(req: IncomingMessage, res: ServerResponse, hello: unknown): void {
    const url = new URL(req.url!, "http://localhost");
    const id = url.searchParams.get("clientId");
    const keys = url.searchParams.getAll("sessionKey");
    validateKeys(keys);
    if (id && !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("无效的远程客户端标识");
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    this.clients.set(res, { keys: id ? new Set(keys) : null });
    this.changed();
    req.on("close", () => { this.clients.delete(res); this.changed(); });
  }

  publish<C extends EventChannel>(channel: C, payload: EventMap[C], seq: number): void {
    const frame = `id: ${seq}\nevent: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const [response, client] of this.clients) {
      if (channel === "chat:rows" && client.keys && !client.keys.has((payload as EventMap["chat:rows"]).sessionKey)) continue;
      if (response.writableLength > MAX_PENDING_BYTES) response.destroy();
      else response.write(frame);
    }
  }

  ping(): void { for (const response of this.clients.keys()) response.write(": ping\n\n"); }
  disconnect(): void {
    for (const response of this.clients.keys()) response.end();
    this.clients.clear();
    this.changed();
  }
}

function validateKeys(keys: string[]): void {
  if (keys.length > MAX_VIEWED_SESSIONS || keys.some(key => typeof key !== "string" || !key || key.length > MAX_KEY_LENGTH)) throw new Error("无效的会话订阅范围");
}
