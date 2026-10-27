// SSH 反向隧道：由本机连出，把服务器上的监听地址转发到本地服务。
// 服务器地址、用户和私钥都写在用户自己的 ~/.ssh/config 中，这里只传 Host 别名。
import { spawn, type ChildProcess } from "node:child_process";
import { networkInterfaces } from "node:os";
import type { TunnelStatus } from "../../shared/remoteControl.js";

export interface TunnelConfig {
  sshHost: string;
  remoteBind: string;
  localPort: number;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];
const FORWARD_RETRY_MS = 2_000;
/** 连上后稳定这么久才把重试间隔重置回最短。 */
const STABLE_MS = 60_000;
const NETWORK_POLL_MS = 2_000;
const NETWORK_SETTLE_MS = 2_000;
const CONNECT_DEADLINE_MS = 20_000;

function networkFingerprint(): string {
  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? []).filter((address) => !address.internal).map((address) => `${name}:${address.family}:${address.address}`),
  ).sort().join("|");
}

/** 只接受 Host 别名，避免把参数当成 ssh 选项。 */
export function validateTunnelConfig(sshHost: string, remoteBind: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sshHost)) return "SSH 主机别名只能包含字母、数字、点、下划线和短横线";
  const match = /^([A-Za-z0-9][A-Za-z0-9.-]*):(\d{1,5})$/.exec(remoteBind);
  const port = match ? Number(match[2]) : 0;
  if (!match || port < 1 || port > 65535) return "服务器监听地址格式应为 地址:端口";
  return undefined;
}

/** 把 ssh 的错误输出归纳成提示，不保存原文（其中含服务器地址和用户名）。 */
function summarize(stderr: string, code: number | null): string {
  if (/Permission denied/i.test(stderr)) return "SSH 认证失败，请检查 ~/.ssh/config 中的用户与私钥";
  if (/Host key verification failed/i.test(stderr)) return "服务器主机密钥未受信任，请先在终端手动 ssh 连接一次";
  if (/Could not resolve hostname/i.test(stderr)) return "无法解析服务器地址";
  if (/remote port forwarding failed/i.test(stderr)) return "服务器转发端口尚未释放，或不允许该监听地址";
  if (/not responding|Broken pipe|Connection reset|Network is unreachable|No route to host/i.test(stderr)) return "网络连接已中断";
  if (/timed out/i.test(stderr)) return "连接服务器超时";
  if (/Connection refused/i.test(stderr)) return "服务器拒绝连接";
  if (/Bad configuration option|Can't open user config|no argument after keyword/i.test(stderr)) return "~/.ssh/config 配置有误";
  return `SSH 已退出（代码 ${code ?? "未知"}）`;
}

export class ReverseTunnel {
  private child: ChildProcess | null = null;
  private config: TunnelConfig | null = null;
  private retry = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private networkTimer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private restartAfterExit = false;
  private status: TunnelStatus = { state: "off" };

  constructor(
    private readonly env: () => Record<string, string>,
    private readonly onStatus: (status: TunnelStatus) => void,
  ) {}

  getStatus(): TunnelStatus {
    return this.status;
  }

  /** 配置相同且正在运行时保持现有连接。 */
  start(config: TunnelConfig) {
    const same = this.config && this.config.sshHost === config.sshHost && this.config.remoteBind === config.remoteBind && this.config.localPort === config.localPort;
    if (same && (this.child || this.retryTimer)) return;
    this.config = config;
    this.retry = 0;
    this.clearTimers();
    this.watchNetwork();
    // 保留旧进程引用，直到退出后再创建新进程，避免两个隧道竞争同一端口。
    if (this.child) {
      this.setStatus({ state: "connecting" });
      this.terminateChild();
    } else this.connect();
  }

  stop() {
    this.config = null;
    this.clearTimers();
    if (this.networkTimer) clearInterval(this.networkTimer);
    this.networkTimer = null;
    this.terminateChild();
    this.setStatus({ state: "off" });
  }

  /** 网络稳定或系统唤醒后，重建连接；连续通知只触发一次。 */
  reconnect() {
    if (!this.config) return;
    this.clearTimers();
    this.setStatus({ state: "connecting" });
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      this.retry = 0;
      if (this.child) this.terminateChild();
      else this.connect();
    }, NETWORK_SETTLE_MS);
  }

  private watchNetwork() {
    if (this.networkTimer) return;
    let fingerprint = networkFingerprint();
    let lastTick = Date.now();
    this.networkTimer = setInterval(() => {
      const current = networkFingerprint();
      const now = Date.now();
      // 时间间隔同时覆盖系统睡眠；不依赖桌面窗口是否仍然打开。
      if (current !== fingerprint || now - lastTick > NETWORK_POLL_MS * 3) this.reconnect();
      fingerprint = current;
      lastTick = now;
    }, NETWORK_POLL_MS);
    this.networkTimer.unref();
  }

  private terminateChild(restart = true) {
    const child = this.child;
    if (!child) return;
    this.restartAfterExit = restart;
    if (this.stopping) return;
    this.stopping = true;
    child.kill();
    this.killTimer = setTimeout(() => {
      if (this.child === child) child.kill("SIGKILL");
    }, 2_000);
    this.killTimer.unref();
  }

  private connect() {
    const config = this.config;
    if (!config || this.child || this.recoveryTimer) return;
    this.setStatus({ state: "connecting" });
    // -v 只用于识别“转发已建立”；输出不写入日志。
    const child = spawn("/usr/bin/ssh", [
      "-N", "-v",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      // 隧道必须属于此进程，不能复用或遗留到 SSH 后台主连接。
      "-o", "ControlMaster=no",
      "-o", "ControlPath=none",
      "-o", "ControlPersist=no",
      "-o", "ForkAfterAuthentication=no",
      "-o", "ServerAliveInterval=5",
      "-o", "ServerAliveCountMax=2",
      "-o", "ConnectTimeout=10",
      "-R", `${config.remoteBind}:127.0.0.1:${config.localPort}`,
      "--", config.sshHost,
    ], { env: this.env(), stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    let stderr = "";
    let connected = false;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      stderr = "连接服务器超时 timed out";
      // 超时属于连接失败，继续正常退避重试。
      this.terminateChild(false);
    }, CONNECT_DEADLINE_MS);
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      if (this.child !== child) return;
      // 只保留最近一段输出用于归纳错误
      stderr = (stderr + chunk).slice(-8192);
      if (!connected && !this.stopping && /remote forward success/i.test(stderr)) {
        connected = true;
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.setStatus({ state: "connected" });
        this.stableTimer = setTimeout(() => { this.retry = 0; }, STABLE_MS);
      }
    });
    const finish = (code: number | null) => {
      if (this.child !== child) return;
      const intentional = this.restartAfterExit;
      this.child = null;
      this.stopping = false;
      this.restartAfterExit = false;
      if (this.killTimer) clearTimeout(this.killTimer);
      this.killTimer = null;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.connectTimer = this.stableTimer = null;
      if (!this.config || this.recoveryTimer) return;
      if (intentional) {
        this.connect();
        return;
      }
      // 端口占用时旧会话可能正在清理，保持短间隔等待监听释放。
      const delay = /remote port forwarding failed/i.test(stderr) ? FORWARD_RETRY_MS : RETRY_DELAYS_MS[Math.min(this.retry++, RETRY_DELAYS_MS.length - 1)]!;
      this.setStatus({ state: "error", error: `${summarize(stderr, code)}；${Math.round(delay / 1000)} 秒后重试` });
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect();
      }, delay);
    };
    child.on("close", finish);
    child.on("error", () => {
      // spawn 失败没有进程；已有进程的其他错误仍须等待 close，避免提前重连。
      if (!child.pid) finish(null);
    });
  }

  private clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.retryTimer = null;
    this.stableTimer = null;
    this.connectTimer = null;
    this.recoveryTimer = null;
  }

  private setStatus(status: TunnelStatus) {
    this.status = status;
    this.onStatus(status);
  }
}
