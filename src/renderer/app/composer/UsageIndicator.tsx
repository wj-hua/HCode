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
  if (seconds < 60) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
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
  const hasMetrics = usage.ttftMs !== undefined || usage.outputSpeedDurationMs !== undefined || usage.outputTokensPerSecond !== undefined;
  if (!hasContext && !hasMetrics && !stats && !usage.statisticsSaveError) return null;

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
          {hasMetrics ? (
            <div className={cn("grid gap-1.5", hasContext && "border-t border-border pt-3")}>
              {usage.ttftMs !== undefined ? <Row label="首输出延迟（TTFT）" value={`${(usage.ttftMs / 1000).toFixed(2)} s`} /> : null}
              {usage.outputSpeedDurationMs !== undefined ? <Row label="有效响应耗时" value={`${(usage.outputSpeedDurationMs / 1000).toFixed(2)} s`} /> : null}
              {usage.outputTokensPerSecond !== undefined ? <Row label={usage.outputSpeedBasis === "activeTurn" ? "平均响应吞吐（估算）" : "输出速度（估算）"} value={`${usage.outputTokensPerSecond.toFixed(1)} tokens/s`} /> : null}
            </div>
          ) : null}
          {stats ? (
            <div className={cn("grid gap-1.5", (hasContext || hasMetrics) && "border-t border-border pt-3")}>
              <div className="mb-1 text-ui-sm font-medium text-foreground">会话累计（HCode 已记录）</div>
              <Row label="累计轮次" value={`${stats.turns} 轮`} />
              {stats.responseTurns > 0 ? <Row label="已计时响应耗时" value={formatDuration(stats.responseMs)} /> : null}
              <Row label="工具累计耗时" value={formatDuration(stats.toolMs)} />
              <Row label="已计时工具调用" value={`${stats.toolCalls} 次`} />
              {stats.ttftTurns > 0 ? <Row label="平均首输出延迟" value={`${(stats.ttftMs / stats.ttftTurns / 1000).toFixed(2)} s`} /> : null}
              {stats.activeTurnMs > 0 ? <Row label="累计平均响应吞吐" value={`${(stats.activeTurnTokens * 1000 / stats.activeTurnMs).toFixed(1)} tokens/s`} /> : null}
              {stats.responseSpeedMs > 0 ? <Row label="累计响应生成速度" value={`${(stats.responseTokens * 1000 / stats.responseSpeedMs).toFixed(1)} tokens/s`} /> : null}
              {stats.usageTurns > 0 ? <>
                <Row label="累计输入 Token" value={stats.inputTokens.toLocaleString(LOCALE)} />
                <Row label="累计输出 Token" value={stats.outputTokens.toLocaleString(LOCALE)} />
              </> : null}
              <p className="mt-1 text-ui-xs text-foreground-subtle">
                已结束轮次的统计；并行工具分别累计耗时。响应计时覆盖 {stats.responseTurns}/{stats.turns} 轮，TTFT 覆盖 {stats.ttftTurns} 轮，用量覆盖 {stats.usageTurns} 轮。
                {stats.incompleteTools > 0 ? `另有 ${stats.incompleteTools} 次工具缺少完整计时。` : ""}
              </p>
            </div>
          ) : null}
          {usage.statisticsSaveError ? <p className="text-ui-xs text-warning">{usage.statisticsSaveError}</p> : null}
        </ContextContentBody>
      </ContextContent>
    </Context>
  );
}
