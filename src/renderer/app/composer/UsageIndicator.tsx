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
  if (!hasContext && !hasTurnUsage) return null;

  return (
    <Context usedTokens={hasContext ? used : 0} maxTokens={hasContext ? window : 1}>
      <ContextTrigger>
        <Button type="button" variant="ghost" size="sm" className={cn("h-7 gap-1 rounded-lg px-2 text-ui-sm", tone)} aria-label="上下文与本轮用量">
          {hasContext ? <ContextIcon /> : null}
          {hasContext ? `上下文 ${Math.round(percent!)}%` : "本轮用量"}
        </Button>
      </ContextTrigger>
      <ContextContent side="top" align="end" className="!w-68">
        <ContextContentBody className="space-y-2 text-ui-sm">
          <div className="font-medium text-foreground">上下文与本轮用量</div>
          {hasContext ? (
            <>
              <div className="flex justify-between gap-3"><span>上下文占用</span><span className={tone}>{tokens.format(used)} / {tokens.format(window)}（{percent!.toFixed(1)}%）</span></div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface"><div className={cn("h-full rounded-full", percent! >= 90 ? "bg-destructive" : percent! >= 75 ? "bg-warning" : "bg-brand")} style={{ width: `${Math.min(100, percent!)}%` }} /></div>
            </>
          ) : null}
          {usage.inputTokens !== undefined ? <div className="flex justify-between gap-3"><span>本轮输入</span><span>{tokens.format(usage.inputTokens)} tokens</span></div> : null}
          {usage.outputTokens !== undefined ? <div className="flex justify-between gap-3"><span>本轮输出</span><span>{tokens.format(usage.outputTokens)} tokens</span></div> : null}
        </ContextContentBody>
      </ContextContent>
    </Context>
  );
}
