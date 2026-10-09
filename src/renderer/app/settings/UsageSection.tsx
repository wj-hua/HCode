// 用量统计：近 30 天的输入 / 输出 Token，数据来自主进程按轮累计的 usage.json。
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { AgentKind, UsageStats } from "@hcode/shared/types";
import { AGENT_KINDS, AGENTS } from "@hcode/shared/agents";
import { Button } from "@/components/ui/button.js";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart.js";
import { hcode } from "../bridge";

const DAYS = 30;
const full = new Intl.NumberFormat("zh-CN");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function formatTokens(value: number): string {
  return compact.format(value).replace(/[KBT]/g, (unit) => unit.toLowerCase());
}

const chartConfig = {
  input: { label: "输入", color: "var(--color-sky-500)" },
  output: { label: "输出", color: "var(--color-amber-500)" },
} satisfies ChartConfig;

/** 近 DAYS 天（含今天）的本地日期，从旧到新。 */
function recentDates(): string[] {
  return Array.from({ length: DAYS }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (DAYS - 1 - index));
    return date.toLocaleDateString("en-CA");
  });
}

export function UsageSection({ open }: { open: boolean }) {
  const [stats, setStats] = useState<UsageStats>({});
  const [agent, setAgent] = useState<AgentKind | "all">("all");

  useEffect(() => {
    if (open) void hcode.invoke("usage:get").then(setStats);
  }, [open]);

  const { days, models, total } = useMemo(() => {
    const kinds = agent === "all" ? AGENT_KINDS : [agent];
    const byModel = new Map<string, { input: number; output: number; turns: number }>();
    const total = { input: 0, output: 0, turns: 0 };
    const days = recentDates().map((date) => {
      const day = { date: date.slice(5), input: 0, output: 0 };
      for (const kind of kinds) {
        for (const [model, bucket] of Object.entries(stats[date]?.[kind] ?? {})) {
          day.input += bucket.input;
          day.output += bucket.output;
          total.input += bucket.input;
          total.output += bucket.output;
          total.turns += bucket.turns;
          const sum = byModel.get(model) ?? { input: 0, output: 0, turns: 0 };
          sum.input += bucket.input;
          sum.output += bucket.output;
          sum.turns += bucket.turns;
          byModel.set(model, sum);
        }
      }
      return day;
    });
    const models = [...byModel].sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output));
    return { days, models, total };
  }, [stats, agent]);

  const clear = async () => {
    if (!window.confirm("清空所有用量统计？此操作不可恢复。")) return;
    await hcode.invoke("usage:clear");
    setStats({});
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1">
        <Button variant={agent === "all" ? "secondary" : "ghost"} size="sm" onClick={() => setAgent("all")}>全部</Button>
        {AGENT_KINDS.map((kind) => (
          <Button key={kind} variant={agent === kind ? "secondary" : "ghost"} size="sm" onClick={() => setAgent(kind)}>
            {AGENTS[kind].name}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "输入 Token", value: formatTokens(total.input) },
          { label: "输出 Token", value: formatTokens(total.output) },
          { label: "对话轮数", value: full.format(total.turns) },
        ].map(({ label, value }) => (
          <div key={label} className="flex flex-col rounded-lg border border-border bg-surface px-3 py-2">
            <span className="text-ui-sm text-foreground-subtle">{label}（近 {DAYS} 天）</span>
            <span className="text-lg font-medium text-foreground tabular-nums">{value}</span>
          </div>
        ))}
      </div>
      <ChartContainer className="h-56 w-full" config={chartConfig}>
        <BarChart data={days} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" axisLine={false} tickLine={false} tickMargin={8} minTickGap={16} />
          <YAxis axisLine={false} tickLine={false} width={60} tickFormatter={formatTokens} />
          <ChartTooltip content={
            <ChartTooltipContent formatter={(value, name) => (
              <>
                <div className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: chartConfig[name as keyof typeof chartConfig]?.color }} />
                <div className="flex flex-1 justify-between gap-4 leading-none">
                  <span className="text-muted-foreground">{chartConfig[name as keyof typeof chartConfig]?.label ?? name}</span>
                  <span className="font-mono font-medium text-foreground tabular-nums">{formatTokens(Number(value))}</span>
                </div>
              </>
            )} />
          } />
          <Bar dataKey="input" stackId="tokens" fill="var(--color-input)" />
          <Bar dataKey="output" stackId="tokens" fill="var(--color-output)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ChartContainer>
      <div className="flex flex-col divide-y divide-border/60">
        {models.length === 0 ? (
          <span className="py-3 text-ui-sm text-foreground-subtle">暂无数据。只统计在 HCode 内完成的对话轮次。</span>
        ) : (
          models.map(([model, sum]) => (
            <div key={model} className="flex items-center justify-between gap-4 py-2 text-ui-sm">
              <span className="min-w-0 truncate text-foreground">{model}</span>
              <span className="shrink-0 text-foreground-subtle tabular-nums">
                输入 {formatTokens(sum.input)} · 输出 {formatTokens(sum.output)} · {sum.turns} 轮
              </span>
            </div>
          ))
        )}
      </div>
      <div>
        <Button variant="outline" size="lg" onClick={() => void clear()}>清空统计</Button>
      </div>
    </div>
  );
}
