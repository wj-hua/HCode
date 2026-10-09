// 应用管理的非项目会话分区：复用多 CLI 历史与会话操作，不参与项目排序、移除或置顶。
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import type { Project } from "@hcode/shared/types";
import { sortSessionsWithPins } from "@hcode/shared/sessionPins";
import { Button } from "@/components/ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { useAppStore } from "../store/appStore";
import { SessionItem } from "./SessionItem";

const PAGE_SIZE = 10;

export function ConversationSection({ workspace, query }: { workspace: Project; query: string }) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const sessions = useAppStore((state) => state.sessions[workspace.path]);
  const error = useAppStore((state) => state.sessionErrors[workspace.path]);
  const expanded = useAppStore((state) => state.expanded[workspace.path] ?? true);
  const toggleProject = useAppStore((state) => state.toggleProject);
  const loadSessions = useAppStore((state) => state.loadSessions);
  const newConversation = useAppStore((state) => state.workOutsideProject);
  const pending = useAppStore((state) => state.conversationWorkspacePending);
  const pins = useAppStore((state) => state.settings.pinnedSessions);
  const matching = (sessions ?? []).filter((session) => !query || session.title.toLowerCase().includes(query) || workspace.name.includes(query));
  const sorted = sortSessionsWithPins(matching, pins);

  return (
    <section aria-label="对话" className="group/purpose-section relative pb-3">
      <Collapsible open={expanded} onOpenChange={(open) => toggleProject(workspace.path, open)}>
        <div className="flex h-7 min-w-0 items-center">
          <CollapsibleTrigger asChild>
            <button type="button" className="flex h-7 min-w-0 flex-1 items-center gap-1 px-2.5 text-left text-ui-base font-medium text-foreground-subtlest hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30">
              对话
              {expanded ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
            </button>
          </CollapsibleTrigger>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="新建非项目对话" title="不在项目中工作" disabled={pending} onClick={() => void newConversation(true)} className="mr-1.5 text-foreground-subtle hover:text-foreground">
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
        <CollapsibleContent>
          {error ? (
            <div role="alert" className="px-3 py-2 text-ui-sm text-destructive">
              读取对话失败：{error}
              <button type="button" className="ml-2 underline" onClick={() => void loadSessions(workspace.path)}>重试</button>
            </div>
          ) : !sessions ? (
            <div role="status" className="px-3 py-2 text-ui-base text-foreground-subtle">读取对话中…</div>
          ) : sorted.length === 0 ? (
            <div className="px-3 py-2 text-ui-base text-foreground-subtle">{query ? "没有匹配的对话" : "尚无对话"}</div>
          ) : null}
          <ul className="space-y-0.5">
            {sorted.slice(0, limit).map((session) => <SessionItem key={`${session.agent}:${session.id}`} session={session} />)}
          </ul>
          {sorted.length > limit ? (
            <button type="button" className="px-3 py-1 text-ui-base text-foreground-subtlest hover:text-foreground" onClick={() => setLimit((value) => value + PAGE_SIZE)}>显示更多</button>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
