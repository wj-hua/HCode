import { useCallback, useEffect, useId, useState } from "react";
import type { ComputerBattery } from "@hcode/shared/types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { hcode } from "../bridge";

const STATUS = { charging: "正在充电", discharging: "使用电池", charged: "已充满", "not-charging": "已接电源，未充电", unknown: "充电状态未知" } as const;

export function ComputerBatteryIndicator() {
  const [battery, setBattery] = useState<ComputerBattery | null>(null);
  const [loading, setLoading] = useState(true);
  const clipId = useId();
  const refresh = useCallback(async () => {
    try { setBattery(await hcode.invoke("system:battery")); }
    catch { setBattery(null); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh]);
  const label = battery ? `电脑电量 ${battery.percentage}%，${STATUS[battery.status]}` : loading ? "正在读取电脑电量" : "电脑电量不可用";
  const charging = battery?.status === "charging";
  const color = battery && battery.percentage <= 20 && !charging ? "text-red-500" : charging ? "text-green-600 dark:text-green-400" : "text-foreground-subtle";
  return <DropdownMenu onOpenChange={(open) => { if (open) void refresh(); }}>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" className={cn("app-no-drag h-9 shrink-0 px-1.5", color)} aria-label={label} title={label}>
        <svg width="32" height="18" viewBox="0 0 32 18" aria-hidden="true">
          <rect x="1" y="2" width="27" height="14" rx="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M29.5 6v6a3 3 0 0 0 0-6" fill="currentColor" />
          {battery ? <>
            <defs><clipPath id={clipId}><rect x="3" y="4" width={23 * battery.percentage / 100} height="10" rx="2" /></clipPath></defs>
            <rect x="3" y="4" width={23 * battery.percentage / 100} height="10" rx="2" fill="currentColor" />
            <text x="14.5" y="11.9" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor">{battery.percentage}</text>
            <text x="14.5" y="11.9" textAnchor="middle" fontSize="8" fontWeight="700" className="fill-background" clipPath={`url(#${clipId})`}>{battery.percentage}</text>
          </> : <text x="14.5" y="12" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor">–</text>}
        </svg>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-44 p-3">
      <p className="text-ui-base font-medium text-foreground">电脑电量</p>
      <p role="status" className="mt-1 text-ui-sm text-foreground-subtle">{battery ? `${battery.percentage}% · ${STATUS[battery.status]}` : loading ? "正在读取…" : "无法读取，或电脑没有内置电池"}</p>
    </DropdownMenuContent>
  </DropdownMenu>;
}
