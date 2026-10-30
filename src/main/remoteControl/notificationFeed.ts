// 通知事件流（通用能力）：把主进程事件归纳为「完成 / 出错 / 等待审批」摘要，供对接方服务器订阅后自行推送。
// 摘要含类型、会话标识与标题、CLI、项目路径与名称、工具名；完成事件另带最后一条回复的开头几句，
// 供订阅方区分同一会话的多次完成。不含命令或错误详情；保留最近 50 条供补发。
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { ServerResponse } from "node:http";
import type { EventChannel, EventMap } from "../../shared/ipc.js";
import type { NotificationFeedEvent } from "../../shared/remoteControl.js";
import type { ChatStateEvent, ConversationRow, PermissionRequestEvent } from "../../shared/types.js";
import { replySummary } from "./notificationSummary.js";

const MAX_EVENTS = 50;
const TITLE_MAX_LENGTH = 120;
const TITLE_LOOKUP_TIMEOUT_MS = 1500;
const BUSY_STATES = new Set<ChatStateEvent["state"]>(["running", "awaitingApproval"]);
/** 订阅方读取过慢时断开，由它带 Last-Event-ID 重连补发。 */
const MAX_PENDING_BYTES = 1024 * 1024;

export class NotificationFeed {
  /** 每次启动不同：重启后旧 id 不会与新事件混淆，订阅方的去重键也不会冲突。 */
  private readonly boot = randomBytes(4).toString("hex");
  private seq = 0;
  private readonly events: NotificationFeedEvent[] = [];
  private readonly states = new Map<string, ChatStateEvent>();
  private readonly subscribers = new Set<ServerResponse>();
  private pending = Promise.resolve();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sessionTitle?: (state: ChatStateEvent) => Promise<string | undefined>,
    private readonly liveRows?: (sessionKey: string) => ConversationRow[] | undefined,
    /** 每条新事件的本机监听方（如微信通知），与 SSE 订阅无关。 */
    private readonly onEvent?: (event: NotificationFeedEvent) => void,
  ) {}

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** 由远程服务的 publish 调用；不论订阅是否开启都归纳，开启后可补发最近事件。 */
  observe<C extends EventChannel>(channel: C, payload: EventMap[C]) {
    if (channel === "chat:state") return this.observeState(payload as ChatStateEvent);
    if (channel === "permission:requested") return this.observePermission(payload as PermissionRequestEvent);
  }

  /**
   * lastEventId 属于本次启动时返回其后的事件；属于其他启动（HCode 重启过）时返回全部缓存。
   * 没有 lastEventId 表示首次订阅，默认不补发旧事件，避免对接方把历史当新通知推送。
   */
  since(lastEventId: string | undefined, includeAll = false): NotificationFeedEvent[] {
    if (lastEventId === undefined) return includeAll ? [...this.events] : [];
    const [boot, seq] = lastEventId.split(".");
    if (boot !== this.boot) return [...this.events];
    const after = Number(seq);
    return this.events.filter((event) => Number(event.id.split(".")[1]) > after);
  }

  /** 接管一条已鉴权的 SSE 连接：先补发，再持续推送。 */
  attach(res: ServerResponse, lastEventId: string | undefined, onChange: () => void) {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
    res.write("retry: 3000\n\n");
    for (const event of this.since(lastEventId)) res.write(frame(event));
    this.subscribers.add(res);
    onChange();
    res.on("close", () => {
      this.subscribers.delete(res);
      onChange();
    });
  }

  ping() {
    for (const subscriber of this.subscribers) subscriber.write(": ping\n\n");
  }

  disconnectAll() {
    for (const subscriber of this.subscribers) subscriber.end();
    this.subscribers.clear();
  }

  private observeState(event: ChatStateEvent) {
    const previous = this.states.get(event.sessionKey);
    this.states.set(event.sessionKey, event);
    if (!previous || !BUSY_STATES.has(previous.state)) return;
    if (event.state === "idle") return this.emit("done", event);
    if (event.state === "error") return this.emit("error", event);
  }

  private observePermission(event: PermissionRequestEvent) {
    const state = this.states.get(event.sessionKey);
    if (state) return this.emit("approval", state, event.toolName);
  }

  private emit(type: NotificationFeedEvent["type"], state: ChatStateEvent, tool?: string) {
    // 回到空闲的同一时刻读取实时行，之后用户再发消息也不会把下一轮内容混进本条摘要。
    const summary = type === "done" ? this.summary(state.sessionKey) : undefined;
    const event: NotificationFeedEvent = {
      id: `${this.boot}.${++this.seq}`,
      type,
      sessionKey: state.sessionKey,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      agent: state.agent,
      project: basename(state.projectPath),
      projectPath: state.projectPath,
      ...(tool ? { tool } : {}),
      ...(summary ? { summary } : {}),
      at: this.now(),
    };
    if (!this.sessionTitle) return this.publish(event);
    // 标题并行读取，避免连续事件累计等待超时；发送和补发仍保持事件 id 的原始顺序。
    const title = this.readTitle(state);
    this.pending = this.pending.then(async () => {
      const resolvedTitle = await title;
      if (resolvedTitle) event.title = resolvedTitle;
      this.publish(event);
    });
    return this.pending;
  }

  /** CLI 历史可能未就绪、失败或卡住；标题是可选摘要，限时后记录原因并继续发送项目名。 */
  private async readTitle(state: ChatStateEvent): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("title lookup timeout")), TITLE_LOOKUP_TIMEOUT_MS);
      });
      const title = await Promise.race([this.sessionTitle!(state), timeout]);
      return title ? Array.from(title.replace(/\s+/gu, " ").trim()).slice(0, TITLE_MAX_LENGTH).join("") : undefined;
    } catch {
      // 不打印底层错误或标题，避免历史服务把对话内容写入日志。
      console.warn(`[notification-feed] ${state.agent} 会话标题读取失败或超时，发送项目摘要`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private summary(sessionKey: string): string | undefined {
    const rows = this.liveRows?.(sessionKey);
    return rows ? replySummary(rows) : undefined;
  }

  private publish(event: NotificationFeedEvent) {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.onEvent?.(event);
    const data = frame(event);
    for (const subscriber of this.subscribers) {
      if (subscriber.writableLength > MAX_PENDING_BYTES) subscriber.destroy();
      else subscriber.write(data);
    }
  }
}

function frame(event: NotificationFeedEvent): string {
  return `id: ${event.id}\nevent: notification\ndata: ${JSON.stringify(event)}\n\n`;
}
