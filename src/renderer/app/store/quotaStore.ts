// 各来源的订阅额度：主进程缓存并推送更新，这里只保存最新一份。
import { create } from "zustand";
import type { AgentQuota, QuotaSource } from "@hcode/shared/types";
import { QUOTA_SOURCES } from "@hcode/shared/agents";
import { hcode } from "../bridge";

interface QuotaState {
  quotas: Partial<Record<QuotaSource, AgentQuota>>;
  loading: boolean;
  load(force?: boolean): Promise<void>;
}

export const useQuotaStore = create<QuotaState>((set, get) => ({
  quotas: {},
  loading: false,
  async load(force = false) {
    if (get().loading) return;
    set({ loading: true });
    try {
      const list = await hcode.invoke("quota:list", force);
      set({ quotas: Object.fromEntries(list.map((quota) => [quota.agent, quota])) });
    } catch {
      // 保留上一次的数据
    } finally {
      set({ loading: false });
    }
  },
}));

hcode.on("quota:updated", (quota) => {
  useQuotaStore.setState((state) => ({ quotas: { ...state.quotas, [quota.agent]: quota } }));
});

/** 按固定顺序排列。 */
export function orderedQuotas(quotas: Partial<Record<QuotaSource, AgentQuota>>): AgentQuota[] {
  return QUOTA_SOURCES.map((kind) => quotas[kind]).filter((quota): quota is AgentQuota => quota !== undefined);
}
