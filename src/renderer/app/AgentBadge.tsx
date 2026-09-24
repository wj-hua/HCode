// CLI（及额度来源）标识：小方块字母徽标（不使用各家品牌 logo）。
import type { QuotaSource } from "@hcode/shared/types";
import { quotaSourceName } from "@hcode/shared/agents";
import { cn } from "@/components/lib/utils.js";

const STYLE: Record<QuotaSource, { letter: string; className: string }> = {
  claude: { letter: "C", className: "bg-[#d97757] text-white" },
  codex: { letter: "X", className: "bg-foreground text-background" },
  step: { letter: "S", className: "bg-[#2563eb] text-white" },
  agy: { letter: "A", className: "bg-[#16a34a] text-white" },
  pi: { letter: "π", className: "bg-[#7c3aed] text-white" },
  glm: { letter: "Z", className: "bg-[#1e3a8a] text-white" },
};

export function AgentBadge({ agent, className }: { agent: QuotaSource; className?: string }) {
  const style = STYLE[agent];
  return (
    <span
      title={quotaSourceName(agent)}
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
