// 侧边栏底部的订阅额度：每个来源一个徽标 + 5 小时 / 每周两条迷你进度条，点开是详细面板。
// 来源多、放不下时进度条一起缩短（最短 16px），保证每个来源都露出来。
// 面板行样式照 ZCode CodingPlanUsageRemainingPanel，数值同样显示“剩余”。
import type { AgentQuota, QuotaGroup, QuotaWindow } from "@hcode/shared/types";
import { quotaSourceName } from "@hcode/shared/agents";
import { Loader2, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { AgentBadge } from "../AgentBadge";
import { formatRelativeTime, formatResetIn } from "../format";
import { orderedQuotas, useQuotaStore } from "../store/quotaStore";

/** 定时刷新间隔；主进程缓存 3 分钟，未过期时这次请求直接返回缓存。 */
const POLL_MS = 5 * 60 * 1000;

function remainingPercent(limit: QuotaWindow): number {
  return Math.max(0, Math.floor(100 - limit.usedPercent));
}

function barColor(remaining: number): string {
  if (remaining <= 10) return "bg-destructive";
  if (remaining <= 30) return "bg-amber-500";
  return "bg-foreground-subtle";
}

/** 迷你条只看第一组（主额度）的 5 小时和每周窗口。 */
function headlineWindows(quota: AgentQuota): QuotaWindow[] {
  const windows = quota.groups[0]?.windows ?? [];
  const picked = [windows.find((item) => item.kind === "5h"), windows.find((item) => item.kind === "weekly")];
  const result = picked.filter((item): item is QuotaWindow => item !== undefined);
  return result.length ? result : windows.slice(0, 2);
}

function MiniBar({ limit }: { limit: QuotaWindow }) {
  const remaining = remainingPercent(limit);
  return (
    <span className="block h-[3px] w-full overflow-hidden rounded-full bg-foreground/12">
      <span className={cn("block h-full rounded-full", barColor(remaining))} style={{ width: `${remaining}%` }} />
    </span>
  );
}

function QuotaChip({ quota }: { quota: AgentQuota }) {
  const windows = quota.status === "ok" ? headlineWindows(quota) : [];
  const title =
    windows.map((item) => `${item.label}剩余 ${remainingPercent(item)}%`).join("，") || quota.message || "";
  return (
    <span className="flex min-w-0 items-center gap-1" title={`${quotaSourceName(quota.agent)}${title ? `：${title}` : ""}`}>
      <AgentBadge agent={quota.agent} className={cn(windows.length === 0 && "opacity-40")} />
      {windows.length ? (
        <span className="flex w-8 min-w-4 flex-col gap-[3px]">
          {windows.map((item) => (
            <MiniBar key={item.label} limit={item} />
          ))}
        </span>
      ) : null}
    </span>
  );
}

function WindowRow({ limit, now }: { limit: QuotaWindow; now: number }) {
  const remaining = remainingPercent(limit);
  return (
    <div className="py-1.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="min-w-0 truncate text-ui-sm text-foreground">{limit.label}</div>
        <div className="flex min-w-0 items-center gap-2 text-right text-ui-sm">
          <span className="font-medium text-foreground">剩余 {remaining}%</span>
          {limit.resetsAt ? (
            <span className="truncate text-foreground-subtle" title={new Date(limit.resetsAt).toLocaleString()}>
              {formatResetIn(limit.resetsAt, now)}
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-foreground/10">
        <div className={cn("h-full rounded-full", barColor(remaining))} style={{ width: `${remaining}%` }} />
      </div>
    </div>
  );
}

function GroupBlock({ group, now }: { group: QuotaGroup; now: number }) {
  return (
    <div>
      {group.name ? <div className="pt-1 text-ui-xs font-medium text-foreground-subtlest">{group.name}</div> : null}
      {group.windows.map((item) => (
        <WindowRow key={item.label} limit={item} now={now} />
      ))}
    </div>
  );
}

function AgentSection({ quota, now }: { quota: AgentQuota; now: number }) {
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-1.5">
        <AgentBadge agent={quota.agent} />
        <span className="min-w-0 truncate text-ui-base font-medium text-foreground">{quotaSourceName(quota.agent)}</span>
        {quota.plan ? (
          <span className="shrink-0 rounded-full border border-border bg-surface px-2 py-0.5 text-ui-xs leading-none font-medium text-foreground-subtle capitalize">
            {quota.plan}
          </span>
        ) : null}
      </div>
      {quota.status === "error" ? (
        <div className="mt-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-ui-sm break-words text-destructive">
          {quota.message || "读取额度失败"}
        </div>
      ) : quota.status === "unavailable" || quota.groups.length === 0 ? (
        <div className="mt-1 text-ui-sm leading-relaxed text-foreground-subtle">{quota.message || "没有额度数据"}</div>
      ) : (
        <div className="mt-0.5">
          {quota.groups.map((group, index) => (
            <GroupBlock key={group.name ?? index} group={group} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

export function QuotaIndicator() {
  const quotas = useQuotaStore((state) => state.quotas);
  const loading = useQuotaStore((state) => state.loading);
  const load = useQuotaStore((state) => state.load);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  // 面板打开时每分钟刷新一次倒计时
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [open]);

  const list = orderedQuotas(quotas);
  if (list.length === 0) return null;
  const updatedAt = Math.min(...list.map((quota) => quota.updatedAt));

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-7 min-w-0 items-center gap-2 overflow-hidden rounded-md px-1 hover:bg-menu-hover"
          aria-label="订阅额度"
        >
          {list.map((quota) => (
            <QuotaChip key={quota.agent} quota={quota} />
          ))}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 gap-0 p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
          <div className="min-w-0">
            <div className="text-ui-base font-medium text-foreground">订阅额度</div>
            <div className="text-ui-xs text-foreground-subtlest">更新于 {formatRelativeTime(updatedAt, now)}</div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-foreground-subtle"
            disabled={loading}
            aria-label="刷新"
            onClick={() => void load(true)}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCwIcon />}
          </Button>
        </div>
        <div className="max-h-[70vh] divide-y divide-border overflow-y-auto">
          {list.map((quota) => (
            <AgentSection key={quota.agent} quota={quota} now={now} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
