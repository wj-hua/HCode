// 侧边栏底部的订阅额度：每个来源一个徽标 + 5 小时 / 每周两条迷你进度条，点开是详细面板。
// 来源多、放不下时进度条一起缩短（最短 12px），保证每个来源都露出来。
import type { AgentQuota, QuotaGroup, QuotaWindow } from "@hcode/shared/types";
import { quotaSourceName } from "@hcode/shared/agents";
import { AlertCircleIcon, InfoIcon, RefreshCwIcon } from "lucide-react";
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
  if (remaining <= 10) return "bg-rose-500 dark:bg-rose-400";
  if (remaining <= 30) return "bg-amber-500 dark:bg-amber-400";
  return "bg-emerald-500 dark:bg-emerald-400";
}

function statusTextColor(remaining: number): string {
  if (remaining <= 10) return "text-rose-500 dark:text-rose-400 font-bold";
  if (remaining <= 30) return "text-amber-500 dark:text-amber-400 font-semibold";
  return "text-foreground font-semibold";
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
    <span className="block h-[3px] w-full overflow-hidden rounded-full bg-foreground/15 dark:bg-white/15">
      <span
        className={cn("block h-full rounded-full transition-all duration-300", barColor(remaining))}
        style={{ width: `${remaining}%` }}
      />
    </span>
  );
}

function QuotaChip({ quota }: { quota: AgentQuota }) {
  const windows = quota.status === "ok" ? headlineWindows(quota) : [];
  const title =
    windows.map((item) => `${item.label}剩余 ${remainingPercent(item)}%`).join("，") || quota.message || "";
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 transition-colors",
        windows.length === 0 && "opacity-40",
      )}
      title={`${quotaSourceName(quota.agent)}${title ? `：${title}` : ""}`}
    >
      <AgentBadge agent={quota.agent} />
      {windows.length ? (
        <span className="flex w-7 min-w-3 flex-col gap-[2px]">
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
    <div className="flex items-center gap-2 py-0.5 text-ui-xs">
      <span
        className="min-w-10 max-w-16 shrink-0 truncate text-[11px] font-medium text-foreground-subtle"
        title={limit.label}
      >
        {limit.label}
      </span>
      <div className="relative h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-foreground/10 dark:bg-white/10">
        <div
          className={cn("h-full rounded-full transition-all duration-300", barColor(remaining))}
          style={{ width: `${remaining}%` }}
        />
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1.5 tabular-nums text-right">
        <span className={cn("w-9 text-right font-semibold text-ui-xs", statusTextColor(remaining))}>
          {remaining}%
        </span>
        {limit.resetsAt ? (
          <span
            className="w-[6.5rem] truncate text-right text-[11px] text-foreground-subtle/70"
            title={new Date(limit.resetsAt).toLocaleString()}
          >
            {formatResetIn(limit.resetsAt, now)}
          </span>
        ) : (
          <span className="w-[6.5rem]" />
        )}
      </div>
    </div>
  );
}

function GroupBlock({ group, now }: { group: QuotaGroup; now: number }) {
  return (
    <div className="space-y-0.5">
      {group.name ? (
        <div className="flex items-center gap-1.5 pt-0.5 pb-0 text-[10px] font-medium uppercase tracking-wider text-foreground-subtle/80">
          <span>{group.name}</span>
          <div className="h-px flex-1 bg-border/40" />
        </div>
      ) : null}
      <div className="space-y-0.5">
        {group.windows.map((item) => (
          <WindowRow key={item.label} limit={item} now={now} />
        ))}
      </div>
    </div>
  );
}

function AgentSection({ quota, now }: { quota: AgentQuota; now: number }) {
  return (
    <div className="space-y-1.5 rounded-xl border border-border/60 bg-surface/35 px-2.5 py-2 transition-colors hover:bg-surface/50">
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <AgentBadge agent={quota.agent} className="size-3.5 rounded text-[9px]" />
          <span className="truncate text-ui-xs font-semibold text-foreground">
            {quotaSourceName(quota.agent)}
          </span>
          {quota.plan ? (
            <span className="shrink-0 rounded border border-border/50 bg-foreground/6 px-1 py-0.5 text-[9px] font-medium leading-none uppercase tracking-wider text-foreground-subtle">
              {quota.plan}
            </span>
          ) : null}
        </div>
        {quota.status === "error" ? (
          <span className="shrink-0 text-[10px] font-medium text-destructive">异常</span>
        ) : quota.status === "unavailable" ? (
          <span className="shrink-0 text-[10px] font-medium text-foreground-subtlest">未配置</span>
        ) : null}
      </div>

      {quota.status === "error" ? (
        <div className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-ui-xs text-destructive">
          <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="leading-relaxed break-words">{quota.message || "读取额度失败"}</span>
        </div>
      ) : quota.status === "unavailable" || quota.groups.length === 0 ? (
        <div className="flex items-center gap-1.5 rounded-lg border border-border/40 bg-surface/60 px-2.5 py-1.5 text-ui-xs text-foreground-subtle">
          <InfoIcon className="size-3.5 shrink-0 text-foreground-subtlest" />
          <span>{quota.message || "当前登录方式无订阅额度"}</span>
        </div>
      ) : (
        <div className="space-y-1">
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
  const validTimestamps = list.map((q) => q.updatedAt).filter((t) => t > 0);
  const updatedAt = validTimestamps.length > 0 ? Math.min(...validTimestamps) : 0;

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
          className="group flex h-7 min-w-0 items-center gap-1 overflow-hidden rounded-lg border border-transparent px-1.5 transition-all hover:border-border/60 hover:bg-surface/80 active:bg-surface"
          aria-label="订阅额度"
        >
          {list.map((quota) => (
            <QuotaChip key={quota.agent} quota={quota} />
          ))}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[360px] gap-0 overflow-hidden rounded-2xl border-border/80 bg-popover/95 p-0 shadow-2xl backdrop-blur-md"
      >
        <div className="flex items-center justify-between border-b border-border/60 bg-surface/40 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-ui-xs font-semibold tracking-tight text-foreground">订阅额度</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-surface px-2 py-0.5 text-[10px] font-medium text-foreground-subtle">
              <span className={cn("size-1.5 rounded-full", loading ? "animate-pulse bg-amber-400" : "bg-emerald-500")} />
              {loading ? "更新中..." : updatedAt > 0 ? `更新于 ${formatRelativeTime(updatedAt, now)}` : "刚刚"}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5 rounded text-foreground-subtle transition-all hover:bg-surface hover:text-foreground active:scale-95"
            disabled={loading}
            aria-label="刷新"
            title="刷新额度"
            onClick={() => void load(true)}
          >
            <RefreshCwIcon className={cn("size-3 transition-transform", loading && "animate-spin")} />
          </Button>
        </div>
        <div className="max-h-[75vh] space-y-1.5 overflow-y-auto p-2">
          {list.map((quota) => (
            <AgentSection key={quota.agent} quota={quota} now={now} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
