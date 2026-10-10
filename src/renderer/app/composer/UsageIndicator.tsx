import { Button } from "@/components/ui/button.js";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextIcon,
  ContextTrigger,
} from "@/components/ai-elements/context.js";
import { cn } from "@/components/lib/utils.js";
import type { ChatUsage } from "@hcode/shared/types";

const tokens = new Intl.NumberFormat("zh-CN");

export function UsageIndicator({ usage }: { usage?: ChatUsage }) {
  if (!usage) return null;
  const used = usage.contextUsedTokens;
  const window = usage.contextWindowTokens;
  const hasContext = used !== undefined && window !== undefined && window > 0;
  const percent = hasContext ? used / window * 100 : undefined;
  const tone = percent !== undefined && percent >= 90
    ? "text-destructive"
    : percent !== undefined && percent >= 75 ? "text-warning" : "text-foreground-subtle";
  const hasTurnUsage = usage.inputTokens !== undefined || usage.outputTokens !== undefined;
  const hasMetrics = usage.ttftMs !== undefined || usage.outputTokensPerSecond !== undefined;
  if (!hasContext && !hasTurnUsage && !hasMetrics) return null;

  return (
    <Context usedTokens={hasContext ? used : 0} maxTokens={hasContext ? window : 1}>
      <ContextTrigger>
        <Button type="button" variant="ghost" size="sm" className={cn("h-7 gap-1.5 rounded-lg px-2 text-ui-sm tabular-nums", tone)} aria-label="上下文、本轮用量与输出速度">
          {hasContext ? <ContextIcon /> : null}
          {hasContext ? <span>{`上下文 ${Math.round(percent!)}%`}</span> : !hasMetrics ? <span>本轮用量</span> : null}
          {usage.ttftMs !== undefined ? <span>TTFT {(usage.ttftMs / 1000).toFixed(2)}s</span> : null}
          {usage.outputTokensPerSecond !== undefined ? <span>≈{usage.outputTokensPerSecond.toFixed(1)} tokens/s</span> : null}
        </Button>
      </ContextTrigger>
      <ContextContent side="top" align="end" className="!w-80">
        <ContextContentBody className="space-y-2 text-ui-sm">
          <div className="font-medium text-foreground">上下文、本轮用量与输出速度</div>
          {hasContext ? (
            <>
              <div className="flex justify-between gap-3"><span>上下文占用</span><span className={tone}>{tokens.format(used)} / {tokens.format(window)}（{percent!.toFixed(1)}%）</span></div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface"><div className={cn("h-full rounded-full", percent! >= 90 ? "bg-destructive" : percent! >= 75 ? "bg-warning" : "bg-brand")} style={{ width: `${Math.min(100, percent!)}%` }} /></div>
            </>
          ) : null}
          {usage.inputTokens !== undefined ? <div className="flex justify-between gap-3"><span>本轮输入</span><span>{tokens.format(usage.inputTokens)} tokens</span></div> : null}
          {usage.outputTokens !== undefined ? <div className="flex justify-between gap-3"><span>本轮输出</span><span>{tokens.format(usage.outputTokens)} tokens</span></div> : null}
          {usage.ttftMs !== undefined ? <div className="flex justify-between gap-3"><span>首输出延迟（TTFT）</span><span>{(usage.ttftMs / 1000).toFixed(2)} s</span></div> : null}
          {usage.outputSpeedDurationMs !== undefined ? <div className="flex justify-between gap-3"><span>有效响应耗时</span><span>{(usage.outputSpeedDurationMs / 1000).toFixed(2)} s</span></div> : null}
          {usage.outputTokensPerSecond !== undefined ? <div className="flex justify-between gap-3"><span>{usage.outputSpeedBasis === "activeTurn" ? "平均响应吞吐（估算）" : "输出速度（估算）"}</span><span>≈{usage.outputTokensPerSecond.toFixed(1)} tokens/s</span></div> : null}
          {hasMetrics ? (
            <div className="space-y-1 text-foreground-subtle">
              <p>TTFT 从发送到首次收到文字、思考或工具参数，包含 CLI 启动。</p>
              {usage.outputSpeedBasis === "activeTurn"
                ? <p>平均响应吞吐 = 本轮输出 Token ÷ 响应计时。计时包含首输出前的请求等待、隐藏思考及流式输出，扣除能识别的工具执行和审批等待。它衡量整轮响应效率，不能等同于模型逐 Token 解码速度；数据不完整时不显示吞吐。</p>
                : usage.outputSpeedBasis === "response"
                ? <p>速度按各次完整模型响应的 Token 增量与对应时间计算，包含隐藏思考，排除响应之间的工具执行和审批等待。它是客户端测得的平均生成速度；流式缓冲仍可能影响结果。</p>
                : <p>速度按输出 Token 与各段首尾输出间隔估算，不计段间工具执行及审批等待。流式缓冲、隐藏思考及工具 Token 会影响估算；缺少对应的用量或计时数据时不显示速度。</p>}
            </div>
          ) : null}
        </ContextContentBody>
      </ContextContent>
    </Context>
  );
}
