// 订阅额度面板的数据源：缓存各来源的额度，过期或被标记变化后重新读取，并推给渲染进程。
import type { AgentQuota, QuotaSource } from "../shared/types.js";
import type { AgentRegistry } from "./agents/registry.js";
import { glmQuota, quotaError } from "./agents/quota.js";

/** 缓存有效期：面板打开、窗口聚焦时超过这个时间才重新读取。 */
const MAX_AGE_MS = 3 * 60 * 1000;
/** 一轮对话结束后稍等再读，合并短时间内的多次变化。 */
const STALE_DELAY_MS = 5_000;

const GLM_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
/** 按顺序取第一个非空的环境变量作为 GLM Coding Plan 的 API key。 */
const GLM_KEY_ENV = ["Z_AI_API_KEY", "ZAI_API_KEY"];

interface QuotaProvider {
  kind: QuotaSource;
  /** false 表示没安装 CLI / 没配置 key，不显示这一项。 */
  available(): Promise<boolean>;
  getQuota(): Promise<AgentQuota>;
}

async function fetchGlmQuota(apiKey: string): Promise<AgentQuota> {
  const response = await fetch(GLM_QUOTA_URL, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return quotaError("glm", `quota/limit 请求失败：HTTP ${response.status}`);
  return glmQuota(await response.json());
}

export class QuotaService {
  private readonly providers: QuotaProvider[];
  private readonly cache = new Map<QuotaSource, AgentQuota>();
  private readonly inflight = new Map<QuotaSource, Promise<AgentQuota | null>>();
  private readonly staleTimers = new Map<QuotaSource, ReturnType<typeof setTimeout>>();

  constructor(
    agents: AgentRegistry,
    env: () => Record<string, string>,
    private readonly emit: (quota: AgentQuota) => void,
  ) {
    const glmKey = () => GLM_KEY_ENV.map((name) => env()[name]).find((value) => value);
    this.providers = [
      ...agents.all().flatMap((provider): QuotaProvider[] =>
        provider.getQuota
          ? [
              {
                kind: provider.kind,
                available: async () => (await provider.getStatus()).found,
                getQuota: () => provider.getQuota!(),
              },
            ]
          : [],
      ),
      { kind: "glm", available: async () => Boolean(glmKey()), getQuota: () => fetchGlmQuota(glmKey()!) },
    ];
  }

  /** 可用来源的额度；force 时忽略缓存。某个来源失败不影响其他。 */
  async list(force = false): Promise<AgentQuota[]> {
    const results = await Promise.all(
      this.providers.map((provider) => {
        const cached = this.cache.get(provider.kind);
        if (!force && cached && Date.now() - cached.updatedAt < MAX_AGE_MS) return cached;
        return this.fetch(provider);
      }),
    );
    return results.filter((quota): quota is AgentQuota => quota !== null);
  }

  markStale(kind: QuotaSource) {
    const provider = this.providers.find((item) => item.kind === kind);
    if (!provider) return;
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

  private fetch(provider: QuotaProvider): Promise<AgentQuota | null> {
    const kind = provider.kind;
    let pending = this.inflight.get(kind);
    if (!pending) {
      pending = (async () => {
        if (!(await provider.available())) {
          this.cache.delete(kind);
          return null;
        }
        const quota = await provider.getQuota().catch((error: unknown) => quotaError(kind, error));
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
