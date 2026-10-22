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

const LOCALE = "zh-CN";
const tokens = new Intl.NumberFormat(LOCALE);
const percentFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1, style: "percent" });

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-ui-sm">
      <span className="min-w-0 truncate text-foreground-subtle">{label}</span>
      <span className="ml-auto shrink-0 text-right font-mono tabular-nums text-foreground">{value}</span>
    </div>
  );
}

// 照 ZCode ChatContextUsage：输入框工具条只放圆环，hover 弹出紧凑的上下文容量面板。
export function UsageIndicator({ usage }: { usage?: ChatUsage }) {
  if (!usage) return null;
  const used = usage.contextUsedTokens;
  const window = usage.contextWindowTokens;
  const hasContext = used !== undefined && window !== undefined && window > 0;
  const ratio = hasContext ? used / window : 0;
  const tone = ratio >= 0.9 ? "text-destructive" : ratio >= 0.75 ? "text-warning" : "text-foreground-subtle";
  const hasTurnUsage = usage.inputTokens !== undefined || usage.outputTokens !== undefined;
  const hasMetrics = usage.ttftMs !== undefined || usage.outputTokensPerSecond !== undefined;
  if (!hasContext && !hasTurnUsage && !hasMetrics) return null;

  return (
    <Context usedTokens={hasContext ? used : 0} maxTokens={hasContext ? window : 1}>
      <ContextTrigger aria-label="上下文容量" className={tone} />
      <ContextContent className="!w-80 !rounded-xl !shadow-md" side="top" sideOffset={2}>
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
          {hasTurnUsage || hasMetrics ? (
            <div className={cn("grid gap-1.5", hasContext && "border-t border-border pt-3")}>
              {usage.inputTokens !== undefined ? <Row label="本轮输入" value={`${tokens.format(usage.inputTokens)} tokens`} /> : null}
              {usage.outputTokens !== undefined ? <Row label="本轮输出" value={`${tokens.format(usage.outputTokens)} tokens`} /> : null}
              {usage.ttftMs !== undefined ? <Row label="首输出延迟（TTFT）" value={`${(usage.ttftMs / 1000).toFixed(2)} s`} /> : null}
              {usage.outputSpeedDurationMs !== undefined ? <Row label="有效响应耗时" value={`${(usage.outputSpeedDurationMs / 1000).toFixed(2)} s`} /> : null}
              {usage.outputTokensPerSecond !== undefined ? <Row label={usage.outputSpeedBasis === "activeTurn" ? "平均响应吞吐（估算）" : "输出速度（估算）"} value={`${usage.outputTokensPerSecond.toFixed(1)} tokens/s`} /> : null}
            </div>
          ) : null}
        </ContextContentBody>
      </ContextContent>
    </Context>
  );
}
