// 订阅额度面板的数据源：缓存各 CLI 的额度，过期或被标记变化后重新读取，并推给渲染进程。
import type { AgentKind, AgentQuota } from "../shared/types.js";
import type { AgentRegistry } from "./agents/registry.js";
import { quotaError } from "./agents/quota.js";
import type { AgentProvider } from "./agents/types.js";

/** 缓存有效期：面板打开、窗口聚焦时超过这个时间才重新读取。 */
const MAX_AGE_MS = 3 * 60 * 1000;
/** 一轮对话结束后稍等再读，合并短时间内的多次变化。 */
const STALE_DELAY_MS = 5_000;

export class QuotaService {
  private readonly cache = new Map<AgentKind, AgentQuota>();
  private readonly inflight = new Map<AgentKind, Promise<AgentQuota | null>>();
  private readonly staleTimers = new Map<AgentKind, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly agents: AgentRegistry,
    private readonly emit: (quota: AgentQuota) => void,
  ) {}

  /** 已安装且支持额度的 CLI 的额度；force 时忽略缓存。某个 CLI 失败不影响其他。 */
  async list(force = false): Promise<AgentQuota[]> {
    const results = await Promise.all(
      this.agents.all().map((provider) => {
        if (!provider.getQuota) return null;
        const cached = this.cache.get(provider.kind);
        if (!force && cached && Date.now() - cached.updatedAt < MAX_AGE_MS) return cached;
        return this.fetch(provider);
      }),
    );
    return results.filter((quota): quota is AgentQuota => quota !== null);
  }

  markStale(kind: AgentKind) {
    const provider = this.agents.get(kind);
    if (!provider.getQuota) return;
    const timer = this.staleTimers.get(kind);
    if (timer) clearTimeout(timer);
    this.staleTimers.set(
      kind,
      setTimeout(() => {
        this.staleTimers.delete(kind);
        void this.fetch(provider);
      }, STALE_DELAY_MS),
    );
  }

  private fetch(provider: AgentProvider): Promise<AgentQuota | null> {
    const kind = provider.kind;
    let pending = this.inflight.get(kind);
    if (!pending) {
      pending = (async () => {
        const status = await provider.getStatus();
        if (!status.found) {
          this.cache.delete(kind);
          return null;
        }
        const quota = await provider.getQuota!().catch((error: unknown) => quotaError(kind, error));
        this.cache.set(kind, quota);
        this.emit(quota);
        return quota;
      })().finally(() => this.inflight.delete(kind));
      this.inflight.set(kind, pending);
    }
    return pending;
  }

  dispose() {
    for (const timer of this.staleTimers.values()) clearTimeout(timer);
    this.staleTimers.clear();
  }
}
