import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextTrigger,
} from "@/components/ai-elements/context.js";
import { cn } from "@/components/lib/utils.js";
import { Progress } from "@/components/ui/progress.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import type { ChatUsage } from "@hcode/shared/types";
import { Gauge } from "lucide-react";

const LOCALE = "zh-CN";
const percentFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1, style: "percent" });

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-ui-sm">
      <span className="min-w-0 truncate text-foreground-subtle">{label}</span>
      <span className="ml-auto shrink-0 text-right font-mono tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${(ms / 1000).toFixed(1)}秒`;
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

// 照 ZCode ChatContextUsage：输入框工具条只放圆环，hover 弹出紧凑的上下文容量面板。
export function UsageIndicator({ usage }: { usage?: ChatUsage }) {
  if (!usage) return null;
  const used = usage.contextUsedTokens;
  const window = usage.contextWindowTokens;
  const hasContext = used !== undefined && window !== undefined && window > 0;
  const ratio = hasContext ? used / window : 0;
  const tone = ratio >= 0.9 ? "text-destructive" : ratio >= 0.75 ? "text-warning" : "text-foreground-subtle";
  const stats = usage.sessionStatistics;
  // 模型用时只算模型生成区间（两种口径相加），工具执行与审批等待不计入。
  const modelMs = stats ? stats.activeTurnMs + stats.responseSpeedMs : 0;
  if (!hasContext && !stats && !usage.statisticsSaveError) return null;

  return (
    <Context usedTokens={hasContext ? used : 0} maxTokens={hasContext ? window : 1}>
      <ContextTrigger aria-label="上下文容量" className={tone} />
      <ContextContent className="!w-80 !max-h-(--radix-hover-card-content-available-height) !overflow-y-auto !rounded-xl !shadow-md" side="top" sideOffset={2}>
        <ContextContentBody className="space-y-3">
          {hasContext ? (
            <div className="space-y-2">
              <div className="mb-3 flex min-w-0 items-center gap-3">
                <span className="shrink-0 text-ui-base font-medium text-foreground">上下文容量</span>
                <span className="ml-auto shrink-0 text-right font-mono text-ui-sm text-foreground-subtle">
                  {`${formatCompactTokenNumber(LOCALE, used)}/${formatCompactTokenNumber(LOCALE, window, { maximumFractionDigits: 0 })} (${percentFormat.format(ratio)})`}
                </span>
              </div>
              <Progress
                className="h-2 bg-surface"
                indicatorClassName={cn("min-w-2", ratio >= 0.9 ? "bg-destructive" : ratio >= 0.75 ? "bg-warning" : "bg-(--color-usage-chart-1)")}
                value={ratio * 100}
              />
            </div>
          ) : null}
          {stats ? (
            <div className={cn("grid gap-1.5", hasContext && "border-t border-border pt-3")}>
              <div className="mb-1 flex min-w-0 items-center gap-2 text-ui-sm font-medium text-foreground">
                <Gauge className="size-3.5 shrink-0" aria-hidden />
                <span>会话统计</span>
                <span className="ml-auto shrink-0 tabular-nums">{`${stats.turns} 轮 ${stats.toolCalls} 步`}</span>
              </div>
              {modelMs > 0 ? <Row label="模型用时" value={formatDuration(modelMs)} /> : null}
              <Row label="工具调用用时" value={formatDuration(stats.toolMs)} />
              {stats.ttftTurns > 0 ? <Row label="首 token 平均（TTFT）" value={formatDuration(stats.ttftMs / stats.ttftTurns)} /> : null}
              {modelMs > 0 ? <Row label="输出速度（TPS）" value={`${Math.round((stats.activeTurnTokens + stats.responseTokens) * 1000 / modelMs)} tok/s`} /> : null}
            </div>
          ) : null}
          {usage.statisticsSaveError ? <p className="text-ui-xs text-warning">{usage.statisticsSaveError}</p> : null}
        </ContextContentBody>
      </ContextContent>
    </Context>
  );
}
