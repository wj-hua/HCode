import { ArrowRightIcon, ChevronRightIcon, CircleCheckIcon, CircleIcon, ListTodoIcon } from "lucide-react";
import { useMemo } from "react";
import { cn } from "@/components/lib/utils.js";
import type { Conversation } from "../store/appStore";
import { selectTaskList } from "./taskList";

const STATUS_TEXT = { pending: "待完成", in_progress: "进行中", completed: "已完成" };

export function TaskListPanel({ conversation }: { conversation: Conversation }) {
  const plan = useMemo(() => selectTaskList(conversation), [conversation.agent, conversation.rows, conversation.runState]);
  if (!plan || conversation.loading || conversation.loadError) return null;

  return (
    <section aria-label="任务清单" className="mb-2 rounded-xl border border-border/60 bg-surface/40">
      <details key={`${conversation.viewId}:${plan.turnId}`} className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 text-ui-sm outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ListTodoIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
          <span className="shrink-0 text-foreground-subtle">已完成 {plan.completed} / {plan.steps.length}</span>
          <span className="min-w-0 flex-1 truncate text-foreground" title={plan.current}>{plan.current}</span>
          <ChevronRightIcon className="size-3.5 shrink-0 text-foreground-subtle group-open:rotate-90" aria-hidden="true" />
        </summary>
        <ul className="max-h-48 space-y-1 overflow-y-auto border-t border-border/60 px-3 py-2 text-ui-sm">
          {plan.steps.map((step, index) => {
            const Icon = step.status === "completed" ? CircleCheckIcon : step.status === "in_progress" ? ArrowRightIcon : CircleIcon;
            return (
              <li key={`${step.id}:${index}`} className="flex min-w-0 items-start gap-2 py-1">
                <Icon className={cn("mt-0.5 size-3.5 shrink-0", step.status === "completed" ? "text-success" : step.status === "in_progress" ? "text-foreground" : "text-foreground-subtlest")} aria-hidden="true" />
                <span className="sr-only">{STATUS_TEXT[step.status]}：</span>
                <span className={cn("min-w-0 whitespace-pre-wrap break-words", step.status === "completed" ? "text-foreground-subtlest line-through" : step.status === "in_progress" ? "text-foreground" : "text-foreground-subtle")}>{step.title}</span>
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
