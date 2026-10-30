// 微信通知：把通知事件流的「完成 / 出错 / 等待审批」摘要推送到用户微信。默认关闭，由设置开关控制。
// 扫码登录只给出机器人身份，拿不到用户；用户先在微信给机器人发一条消息，记下发送人与 context_token 后才能推送。
// 接收人锁定为第一个发消息的人，其他人发来的消息不会改变推送目标；退出登录或重新扫码后重置。
// 账号凭据、接收人、context_token 与轮询游标经 safeStorage（macOS 钥匙串）加密后存放，不进入 settings.json。
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { safeStorage } from "electron";
import { AGENTS } from "../../shared/agents.js";
import type { NotificationFeedEvent, WeixinNotifyStatus } from "../../shared/remoteControl.js";
import { beginWeixinLogin, getWeixinUpdates, pollWeixinLogin, sendWeixinText, type WeixinInbound, type WeixinLoginQr } from "./weixinApi.js";

const LOGIN_POLL_INTERVAL_MS = 3_000;
const RETRY_DELAY_MS = 5_000;
const WELCOME_TEXT = "已连接 HCode。任务完成、运行出错或等待审批时，会在这里通知你。";
const RESTORED_TEXT = "HCode 微信通知已恢复。";
const RESEND_HINT = "请在微信给机器人发一条消息后重试";

const EVENT_LABEL: Record<NotificationFeedEvent["type"], string> = {
  done: "✅ 任务已完成",
  error: "❌ 运行出错",
  approval: "⏳ 等待审批",
};

interface Account {
  botToken: string;
  botId: string;
  recipientId?: string;
  contextToken?: string;
  /** /getupdates 游标，处理完一批消息后才推进。 */
  buf?: string;
}

interface WeixinNotifierDeps {
  dataDir: string;
  enabled(): boolean;
  onStatus(status: WeixinNotifyStatus): void;
}

export function formatNotification(event: NotificationFeedEvent): string {
  const lines = [`${EVENT_LABEL[event.type]} · ${AGENTS[event.agent].name}`, `项目：${event.project}`];
  if (event.title) lines.push(`会话：${event.title}`);
  if (event.tool) lines.push(`工具：${event.tool}`);
  if (event.summary) lines.push(`回复：${event.summary}`);
  return lines.join("\n");
}

export class WeixinNotifier {
  private readonly path: string;
  private account: Account | null;
  private poller: AbortController | null = null;
  /** 新的扫码、退出登录或关闭开关时递增，让进行中的扫码轮询退出。 */
  private loginGeneration = 0;
  private login: WeixinNotifyStatus["login"];
  private pollError: string | undefined;
  private sendError: string | undefined;
  /** 串行发送，保证通知顺序。 */
  private sending: Promise<void> = Promise.resolve();

  constructor(private readonly deps: WeixinNotifierDeps) {
    this.path = join(deps.dataDir, "weixin-notify");
    this.account = this.load();
  }

  getStatus(): WeixinNotifyStatus {
    const error = this.pollError ?? this.sendError;
    return {
      enabled: this.deps.enabled(),
      state: !this.account ? "loggedOut" : this.account.recipientId ? "ready" : "waiting",
      ...(this.login ? { login: this.login } : {}),
      ...(error ? { error } : {}),
    };
  }

  /** 按开关启动或停止长轮询；关闭时取消进行中的扫码。 */
  apply() {
    if (this.deps.enabled() && this.account) {
      this.startPolling();
    } else {
      this.stopPolling();
      if (!this.deps.enabled()) this.cancelLogin();
    }
    this.emit();
  }

  async startLogin(): Promise<void> {
    if (!this.deps.enabled()) throw new Error("请先开启微信通知");
    const generation = ++this.loginGeneration;
    const qr = await beginWeixinLogin();
    if (generation !== this.loginGeneration) return;
    this.login = { qrUrl: qr.qrUrl, status: "pending" };
    this.emit();
    void this.waitLogin(qr, generation);
  }

  logout() {
    this.cancelLogin();
    this.stopPolling();
    this.account = null;
    this.pollError = this.sendError = undefined;
    rmSync(this.path, { force: true });
    this.emit();
  }

  /** 发送测试消息；失败原因直接抛给界面。 */
  test(): Promise<void> {
    if (!this.account?.recipientId) return Promise.reject(new Error("请先在微信给机器人发一条消息"));
    return this.enqueue("HCode 测试消息：微信通知工作正常。");
  }

  /** 通知事件流的监听方：开关打开且已有接收人时推送，失败只记录在状态里。 */
  notify(event: NotificationFeedEvent) {
    if (!this.deps.enabled() || !this.account?.recipientId) return;
    this.enqueue(formatNotification(event)).catch(() => {});
  }

  dispose() {
    this.cancelLogin();
    this.stopPolling();
  }

  private async waitLogin(qr: WeixinLoginQr, generation: number) {
    while (generation === this.loginGeneration) {
      if (Date.now() > qr.expiresAt) return this.setLogin(generation, { status: "expired" });
      let result: Awaited<ReturnType<typeof pollWeixinLogin>>;
      try {
        result = await pollWeixinLogin(qr.qrCode);
      } catch (error) {
        result = { status: "error", message: errorMessage(error) };
      }
      if (generation !== this.loginGeneration) return;
      if (result.status === "success") {
        // 新账号：旧轮询先停下，接收人与游标全部重置，等用户在微信发第一条消息。
        this.stopPolling();
        try {
          this.save({ botToken: result.botToken, botId: result.botId });
        } catch (error) {
          return this.setLogin(generation, { status: "error", message: errorMessage(error) });
        }
        this.pollError = this.sendError = undefined;
        this.login = undefined;
        this.apply();
        return;
      }
      if (result.status === "pending" || result.status === "scanned") {
        this.setLogin(generation, { status: result.status });
        await sleep(LOGIN_POLL_INTERVAL_MS);
        continue;
      }
      return this.setLogin(generation, result.status === "error" ? { status: "error", message: result.message } : { status: "expired" });
    }
  }

  private setLogin(generation: number, patch: Omit<NonNullable<WeixinNotifyStatus["login"]>, "qrUrl">) {
    if (generation !== this.loginGeneration || !this.login) return;
    if (this.login.status === patch.status && this.login.message === patch.message) return;
    this.login = { qrUrl: this.login.qrUrl, ...patch };
    this.emit();
  }

  private cancelLogin() {
    this.loginGeneration++;
    this.login = undefined;
  }

  private startPolling() {
    if (this.poller) return;
    const controller = new AbortController();
    this.poller = controller;
    void this.poll(controller.signal).finally(() => {
      if (this.poller === controller) this.poller = null;
    });
  }

  private stopPolling() {
    this.poller?.abort();
    this.poller = null;
  }

  private async poll(signal: AbortSignal) {
    while (!signal.aborted && this.account) {
      try {
        const { messages, buf } = await getWeixinUpdates(this.account.botToken, this.account.buf ?? "", signal);
        for (const message of messages) {
          // 处理过程中可能已退出登录或换了账号，不能把旧消息写进新账号。
          if (signal.aborted) return;
          await this.receive(message);
        }
        if (signal.aborted) return;
        if (buf !== this.account.buf) this.save({ ...this.account, buf });
        if (this.pollError) {
          this.pollError = undefined;
          this.emit();
        }
      } catch (error) {
        if (signal.aborted) return;
        this.pollError = `接收微信消息失败：${errorMessage(error)}`;
        this.emit();
        await sleep(RETRY_DELAY_MS, undefined, { signal }).catch(() => {});
      }
    }
  }

  private async receive(message: WeixinInbound) {
    const account = this.account!;
    if (account.recipientId && account.recipientId !== message.fromUserId) return;
    const activated = !account.recipientId;
    const recovering = Boolean(this.sendError);
    this.save({
      ...account,
      recipientId: message.fromUserId,
      ...(message.contextToken ? { contextToken: message.contextToken } : {}),
    });
    this.emit();
    if (activated || recovering) await this.enqueue(activated ? WELCOME_TEXT : RESTORED_TEXT).catch(() => {});
  }

  private enqueue(text: string): Promise<void> {
    const run = this.sending.then(() => this.send(text));
    this.sending = run.catch(() => {});
    return run;
  }

  private async send(text: string) {
    const account = this.account;
    if (!account?.recipientId) return;
    try {
      await sendWeixinText(account.botToken, account.botId, account.recipientId, account.contextToken, text);
    } catch (error) {
      this.sendError = `发送微信通知失败：${errorMessage(error)}。${RESEND_HINT}`;
      this.emit();
      throw error;
    }
    if (this.sendError) {
      this.sendError = undefined;
      this.emit();
    }
  }

  private load(): Account | null {
    try {
      const value = JSON.parse(safeStorage.decryptString(readFileSync(this.path))) as Account;
      return typeof value.botToken === "string" && value.botToken ? value : null;
    } catch {
      return null;
    }
  }

  private save(account: Account) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统加密存储不可用，无法保存微信登录信息");
    writeFileSync(this.path, safeStorage.encryptString(JSON.stringify(account)), { mode: 0o600 });
    this.account = account;
  }

  private emit() {
    this.deps.onStatus(this.getStatus());
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
