// SSH 反向隧道：由本机连出，把服务器上的监听地址转发到本地服务。
// 服务器地址、用户和私钥都写在用户自己的 ~/.ssh/config 中，这里只传 Host 别名。
import { spawn, type ChildProcess } from "node:child_process";
import type { TunnelStatus } from "../../shared/remoteControl.js";

export interface TunnelConfig {
  sshHost: string;
  remoteBind: string;
  localPort: number;
}

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
/** 连上后稳定这么久才把重试间隔重置回最短。 */
const STABLE_MS = 60_000;

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
  if (/remote port forwarding failed/i.test(stderr)) return "服务器拒绝了端口转发：端口被占用或不允许该监听地址";
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
    this.stop();
    this.config = config;
    this.retry = 0;
    this.connect();
  }

  stop() {
    this.config = null;
    this.clearTimers();
    const child = this.child;
    this.child = null;
    child?.kill();
    this.setStatus({ state: "off" });
  }

  private connect() {
    const config = this.config;
    if (!config) return;
    this.setStatus({ state: "connecting" });
    // -v 只用于识别“转发已建立”；输出不写入日志。
    const child = spawn("/usr/bin/ssh", [
      "-N", "-v",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "ConnectTimeout=15",
      "-R", `${config.remoteBind}:127.0.0.1:${config.localPort}`,
      "--", config.sshHost,
    ], { env: this.env(), stdio: ["ignore", "ignore", "pipe"] });
    this.child = child;
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      if (this.child !== child) return;
      // 只保留最近一段输出用于归纳错误
      stderr = (stderr + chunk).slice(-8192);
      if (this.status.state !== "connected" && /remote forward success/i.test(chunk)) {
        this.setStatus({ state: "connected" });
        this.stableTimer = setTimeout(() => { this.retry = 0; }, STABLE_MS);
      }
    });
    const finish = (code: number | null) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearTimers();
      const delay = RETRY_DELAYS_MS[Math.min(this.retry++, RETRY_DELAYS_MS.length - 1)]!;
      this.setStatus({ state: "error", error: `${summarize(stderr, code)}；${Math.round(delay / 1000)} 秒后重试` });
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect();
      }, delay);
    };
    child.on("exit", finish);
    child.on("error", () => finish(null));
  }

  private clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.retryTimer = null;
    this.stableTimer = null;
  }

  private setStatus(status: TunnelStatus) {
    this.status = status;
    this.onStatus(status);
  }
}
