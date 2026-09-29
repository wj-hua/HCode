// 多 CLI 对比：同一组会话并排显示，共用底部输入框（发送即发给每一列）。
import { LoaderIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { AGENTS } from "@hcode/shared/agents";
import { AgentBadge } from "../AgentBadge";
import { Composer } from "../composer/Composer";
import { useAppStore, type Conversation } from "../store/appStore";
import { ConversationView } from "./ConversationView";

const STATE_TEXT: Record<Conversation["runState"], string> = {
  idle: "已完成",
  running: "运行中",
  awaitingApproval: "等待审批",
  error: "出错",
};

export function CompareView({ members, active }: { members: Conversation[]; active: Conversation }) {
  const activateView = useAppStore((state) => state.activateView);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 overflow-x-auto">
        {members.map((conv) => {
          const busy = conv.runState === "running" || conv.runState === "awaitingApproval";
          return (
            <div
              key={conv.viewId}
              onMouseDown={() => activateView(conv.viewId)}
              className={cn(
                "flex min-h-0 min-w-[320px] flex-1 flex-col border-r border-border/60 last:border-r-0",
                conv.viewId === active.viewId && "bg-surface/30",
              )}
            >
              <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/60 px-3 text-ui-sm">
                <AgentBadge agent={conv.agent} />
                <span className="font-medium text-foreground">{AGENTS[conv.agent].name}</span>
                <span className={cn("ml-auto flex items-center gap-1", conv.runState === "error" ? "text-destructive" : "text-foreground-subtle")}>
                  {busy ? <LoaderIcon className="size-3 animate-spin" /> : null}
                  {STATE_TEXT[conv.runState]}
                </span>
              </div>
              <ConversationView conversation={conv} searchTarget={null} column />
            </div>
          );
        })}
      </div>
      <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-4">
        <Composer key={active.compareId} conversation={active} onSubmitted={() => undefined} />
      </div>
    </div>
  );
}
