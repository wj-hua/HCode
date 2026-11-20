import { expect, it, vi } from "vitest";
import type { AgentKind } from "../../shared/types.js";
import type { AgentProvider } from "../agents/types.js";
import { AgentRegistry } from "../agents/registry.js";
import { quotaUnavailable } from "../agents/quota.js";
import { QuotaService } from "../quotaService.js";

it("CLI 不可用时丢弃未过期的额度，恢复后重新查询", async () => {
  let installed = true;
  const getQuota = vi.fn(async () => quotaUnavailable("codex", "当前登录方式没有订阅额度"));
  const codex = {
    kind: "codex",
    getStatus: async () => ({ kind: "codex", found: installed }),
    getQuota,
  } satisfies Pick<AgentProvider, "kind" | "getStatus" | "getQuota">;
  const agents = new AgentRegistry({ codex } as unknown as Record<AgentKind, AgentProvider>);
  const service = new QuotaService(agents, vi.fn());

  expect(await service.list()).toMatchObject([{ agent: "codex", status: "unavailable" }]);
  expect(await service.list()).toHaveLength(1);
  expect(getQuota).toHaveBeenCalledTimes(1);

  installed = false;
  expect(await service.list()).toEqual([]);
  expect(await service.list(true)).toEqual([]);
  expect(getQuota).toHaveBeenCalledTimes(1);

  installed = true;
  expect(await service.list()).toHaveLength(1);
  expect(getQuota).toHaveBeenCalledTimes(2);
});
