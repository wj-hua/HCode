// CLI 标识：小方块字母徽标（不使用各家品牌 logo）。
import type { AgentKind } from "@hcode/shared/types";
import { AGENTS } from "@hcode/shared/agents";
import { cn } from "@/components/lib/utils.js";

const STYLE: Record<AgentKind, { letter: string; className: string }> = {
  claude: { letter: "C", className: "bg-[#d97757] text-white" },
  codex: { letter: "X", className: "bg-foreground text-background" },
};

export function AgentBadge({ agent, className }: { agent: AgentKind; className?: string }) {
  const style = STYLE[agent];
  return (
    <span
      title={AGENTS[agent].name}
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center rounded-[4px] text-[9px] leading-none font-bold",
        style.className,
        className,
      )}
    >
      {style.letter}
    </span>
  );
}
