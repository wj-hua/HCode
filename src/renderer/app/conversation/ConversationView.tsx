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
import { GitTools } from "./GitTools";
import { NativeSubagents } from "./NativeSubagents";
import { useNarrowRemote } from "../remote/useNarrowRemote";
import { useEffect, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isRemote } from "../bridge";
import { EarlierHistory } from "./EarlierHistory";

function DraftGreeting({ narrow }: { narrow: boolean }) {
  const { intl } = useZCodeIntl();
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const timer = window.setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const period = hour >= 5 && hour < 9 ? "morningEarly" : hour < 12 && hour >= 9 ? "morning" : hour < 14 && hour >= 12 ? "noon" : hour < 18 && hour >= 14 ? "afternoon" : hour < 23 && hour >= 18 ? "evening" : "lateNight";
  return (
    <div className="relative mb-8 flex w-full max-w-2xl items-center justify-center">
      <svg aria-hidden="true" viewBox="0 0 400 320" fill="none" className="pointer-events-none absolute left-1/2 top-1/2 w-[min(72vw,25rem)] -translate-x-1/2 -translate-y-1/2 text-foreground-subtlest opacity-30 [mask-image:linear-gradient(to_bottom,black,transparent_80%)]">
        <path d="M50 32h70l55 128-55 128H50l55-128L50 32Zm230 0h70l-55 128 55 128h-70l-55-128 55-128ZM175 140h50v40h-50z" stroke="currentColor" />
      </svg>
      <p className={cn("relative z-10 px-4 text-center font-medium text-foreground", narrow ? "text-xl" : "text-[clamp(1.25rem,2.5vw,1.875rem)]")}>{intl.formatMessage({ id: `chat.empty.greeting.${period}` })}</p>
    </div>
  );
}


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
  const narrow = useNarrowRemote();
  const collaborationOpen = panel?.type === "collaboration" && panel.viewId === conversation.viewId;
  const permissions = useAppStore((state) => state.permissions);
  const agentStatuses = useAppStore((state) => state.agentStatuses);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const outsideProject = useAppStore((state) => state.projects.some((project) => project.path === conversation.projectPath && project.purpose === "conversation"));
  const presentations = usePresentationStore(state => state.entries);
  const associated = presentations.filter(entry => presentationBelongsToSource(entry, conversation)).sort((left, right) => right.createdAt - left.createdAt);
  const latest = associated[0];
  const identity = { agent: conversation.agent, projectPath: conversation.projectPath, sessionKey: conversation.sessionKey, sessionId: conversation.sessionId };
  const displayedResults = new Set(Object.keys(permissions).length ? [] : conversation.rows.flatMap(row => {
    const owned = presentationTaskForTurn(presentations, identity, row.turnId);
    return owned && presentationContent(owned.entry, owned.task).summary ? [owned.entry.id] : [];
  }));
  const { scrollRef, contentRef, onScroll, showJump, followLatest, beforeHistoryLoad } = useConversationScroll(conversation, latest, searchTarget);
  const running = conversation.runState === "running" || conversation.runState === "awaitingApproval";
  const draftEmpty = !column && !conversation.compareId && !conversation.sessionKey && !conversation.sessionId && !conversation.loading && !conversation.loadError && conversation.rows.length === 0;

  return (
    <FilePreviewProvider viewId={conversation.viewId} workspacePath={conversation.projectPath}>
      <div className={cn("conversation-content relative flex min-h-0 min-w-0 flex-1 flex-col", draftEmpty ? "overflow-y-auto overflow-x-hidden before:block before:min-h-[52px] before:content-[''] after:block after:min-h-4 after:flex-1 after:content-['']" : "overflow-hidden", draftEmpty && (narrow ? "before:flex-1" : "before:shrink before:basis-[29dvh]"), collaborationOpen && "collaboration-content")}>
        <div className={cn("relative min-h-0", draftEmpty ? "w-full shrink-0" : "flex-1")}>
          <div ref={scrollRef} onScroll={onScroll} aria-label="会话消息" tabIndex={0} className={cn(draftEmpty ? "w-full" : "absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-contain [scrollbar-gutter:stable]")}>
            <div ref={contentRef} className={cn("mx-auto flex w-full flex-col", draftEmpty ? "max-w-2xl items-center" : "max-w-3xl pt-6 pb-10", column || narrow ? "px-3" : "px-6")}>
              <EarlierHistory conversation={conversation} beforeLoad={beforeHistoryLoad} />
              {!column && !outsideProject && !draftEmpty ? <div className="mb-4 w-full max-w-64 self-end 2xl:absolute 2xl:right-5 2xl:top-4 2xl:z-10"><GitTools workspacePath={conversation.projectPath} running={running} /></div> : null}
              {conversation.loading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-ui-base text-foreground-subtle">
                  <LoaderIcon className="size-4 animate-spin" />
                  正在读取会话…
                </div>
              ) : conversation.loadError ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-ui-base text-destructive">
                  读取会话失败：{conversation.loadError}
                </div>
              ) : draftEmpty ? <DraftGreeting narrow={narrow} /> : conversation.rows.length === 0 ? (
                <div className={cn("flex min-w-0 flex-col items-center gap-2 text-center", narrow ? "py-16" : "py-24")}>
                  <div className="text-ui-lg font-medium text-foreground">和 {AGENTS[conversation.agent].name} 开始对话</div>
                  <div className="max-w-full break-all text-ui-base text-foreground-subtle">{outsideProject ? "不在项目中工作" : <>工作目录：<span className="[overflow-wrap:anywhere]">{conversation.projectPath}</span></>}</div>
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
              {!conversation.loading && !draftEmpty ? <div className="mt-6 space-y-8">
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
        <div className={cn("shrink-0", draftEmpty ? "mx-auto w-full max-w-2xl px-4" : column ? "px-3" : narrow ? "mx-auto w-full max-w-3xl px-3 pb-2" : "mx-auto w-full max-w-3xl px-6 pb-4")}>
          {draftEmpty && agentStatuses !== null && agentStatuses.every((status) => !status.found) ? (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-ui-base">
              <span>没有找到 claude、codex 或 agy 命令。请先安装，或在设置里指定路径。</span>
              {!isRemote ? <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true, "agents")}>打开设置并配置</Button> : null}
            </div>
          ) : null}
          {!conversation.loading && conversation.sessionId ? <NativeSubagents key={`${conversation.agent}:${conversation.projectPath}:${conversation.sessionId}`} agent={conversation.agent} sessionId={conversation.sessionId} projectPath={conversation.projectPath} /> : null}
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
