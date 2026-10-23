import { ExpertConversationResult } from "../collaboration/ExpertConversationResult";
import { presentationBelongsToSource, presentationTaskForTurn, presentationContent } from "@hcode/shared/collaborationPresentation";
import { usePresentationStore } from "../collaboration/presentationStore";
import { CollaborationProgress } from "../collaboration/CollaborationProgress";
import { ArrowDownIcon, LoaderIcon } from "lucide-react";
import { useConversationScroll } from "./useConversationScroll";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useUiStore } from "../store/uiStore";
import { Composer } from "../composer/Composer";
import { AGENTS } from "@hcode/shared/agents";
import { useAppStore, type Conversation } from "../store/appStore";
import { Timeline } from "./Timeline";
import { FilePreviewProvider } from "./FilePreviewContext";
import { TaskListPanel } from "./TaskListPanel";
import { BackgroundTaskPanel } from './BackgroundTaskPanel';


export function ConversationView({
  conversation,
  searchTarget,
  column = false,
}: {
  conversation: Conversation;
  searchTarget: { rowId: number | null; key: number } | null;
  /** 对比分栏中的一列：不带输入框，由对比视图共用底部输入框。 */
  column?: boolean;
}) {
  const panel = useUiStore(state => state.sidePanel);
  const collaborationOpen = panel?.type === "collaboration" && panel.viewId === conversation.viewId;
  const permissions = useAppStore((state) => state.permissions);
  const outsideProject = useAppStore((state) => state.projects.some((project) => project.path === conversation.projectPath && project.purpose === "conversation"));
  const presentations = usePresentationStore(state => state.entries);
  const associated = presentations.filter(entry => presentationBelongsToSource(entry, conversation)).sort((left, right) => right.createdAt - left.createdAt);
  const latest = associated[0];
  const identity = { agent: conversation.agent, projectPath: conversation.projectPath, sessionKey: conversation.sessionKey, sessionId: conversation.sessionId };
  const displayedResults = new Set(Object.keys(permissions).length ? [] : conversation.rows.flatMap(row => {
    const owned = presentationTaskForTurn(presentations, identity, row.turnId);
    return owned && presentationContent(owned.entry, owned.task).summary ? [owned.entry.id] : [];
  }));
  const { scrollRef, contentRef, onScroll, showJump, followLatest } = useConversationScroll(conversation, latest, searchTarget);
  const running = conversation.runState === "running" || conversation.runState === "awaitingApproval";

  return (
    <FilePreviewProvider viewId={conversation.viewId} workspacePath={conversation.projectPath}>
      <div className={cn("conversation-content relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", collaborationOpen && "collaboration-content")}>
        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} onScroll={onScroll} aria-label="会话消息" tabIndex={0} className="absolute inset-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
            <div ref={contentRef} className={cn("mx-auto flex w-full max-w-3xl flex-col pt-6 pb-10", column ? "px-3" : "px-6")}>
              {conversation.loading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-ui-base text-foreground-subtle">
                  <LoaderIcon className="size-4 animate-spin" />
                  正在读取会话…
                </div>
              ) : conversation.loadError ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-ui-base text-destructive">
                  读取会话失败：{conversation.loadError}
                </div>
              ) : conversation.rows.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-24 text-center">
                  <div className="text-ui-lg font-medium text-foreground">和 {AGENTS[conversation.agent].name} 开始对话</div>
                  <div className="text-ui-base text-foreground-subtle">{outsideProject ? "不在项目中工作" : `工作目录：${conversation.projectPath}`}</div>
                </div>
              ) : (
                <Timeline
                  rows={conversation.rows}
                  presentation={{ agent: conversation.agent, projectPath: conversation.projectPath, sessionKey: conversation.sessionKey, sessionId: conversation.sessionId, viewId: conversation.viewId }}
                  workspacePath={conversation.projectPath}
                  permissions={permissions}
                  running={conversation.runState === "running"}
                  canFork={Boolean(AGENTS[conversation.agent].fork && conversation.sessionId) && !running}
                  canResend={!running && !column && !conversation.compareId}
                  highlightedRowId={searchTarget?.rowId ?? null}
                />
              )}
              {!conversation.loading ? <div className="mt-6 space-y-8">
                {latest && (!latest.experts?.summary || latest.experts.busy) ? <CollaborationProgress entry={latest} viewId={conversation.viewId} /> : null}
                {associated.filter(entry => entry.experts?.summary && !displayedResults.has(entry.id)).reverse().map(entry => <ExpertConversationResult key={entry.id} entry={entry} viewId={conversation.viewId} />)}
              </div> : null}
            </div>
          </div>
          {showJump ? (
            <Button
              aria-label="回到最新消息"
              variant="outline"
              size="icon-md"
              className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-background shadow-md"
              onClick={() => followLatest('smooth')}
            >
              <ArrowDownIcon />
            </Button>
          ) : null}
        </div>
        <div className={cn("shrink-0", column ? "px-3" : "mx-auto w-full max-w-3xl px-6 pb-4")}>
          <TaskListPanel conversation={conversation} />
          <BackgroundTaskPanel conversation={conversation} />
          {column ? null : (
            <Composer
              key={conversation.viewId}
              conversation={conversation}
              onSubmitted={() => followLatest()}
            />
          )}
        </div>
      </div>
    </FilePreviewProvider>
  );
}
