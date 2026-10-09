import { ArrowDownIcon, LoaderIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Composer } from "../composer/Composer";
import { AGENTS } from "@hcode/shared/agents";
import { useAppStore, type Conversation } from "../store/appStore";
import { Timeline } from "./Timeline";
import { FilePreviewProvider } from "./FilePreviewContext";
import { TaskListPanel } from "./TaskListPanel";

const STICK_THRESHOLD_PX = 80;

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
  const permissions = useAppStore((state) => state.permissions);
  const outsideProject = useAppStore((state) => state.projects.some((project) => project.path === conversation.projectPath && project.purpose === "conversation"));
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const running = conversation.runState === "running" || conversation.runState === "awaitingApproval";

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // 内容增长时，如果用户停在底部附近就跟随到底
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) scrollToBottom();
    });
    observer.observe(content);
    // 固定任务清单展开或收起会改变消息区高度；停在底部时仍跟随最新消息。
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    if (!conversation.loading) scrollToBottom();
  }, [conversation.loading, scrollToBottom]);

  useLayoutEffect(() => {
    if (conversation.loading || searchTarget?.rowId == null) return;
    const row = contentRef.current?.querySelector(`[data-search-row-id="${searchTarget.rowId}"]`);
    if (!row) return;
    stickRef.current = false;
    row.scrollIntoView({ block: "center" });
  }, [conversation.loading, conversation.rows.length, searchTarget?.key, searchTarget?.rowId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    // 内容增长（如刚发送的新消息）会让距离变大但 scrollTop 不会变小；只有用户向上滚才取消跟随。
    if (distance < STICK_THRESHOLD_PX) stickRef.current = true;
    else if (el.scrollTop < lastScrollTopRef.current) stickRef.current = false;
    lastScrollTopRef.current = el.scrollTop;
    setShowJump(distance > STICK_THRESHOLD_PX * 4);
  };

  return (
    <FilePreviewProvider viewId={conversation.viewId} workspacePath={conversation.projectPath}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto [scrollbar-gutter:stable]">
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
                  workspacePath={conversation.projectPath}
                  permissions={permissions}
                  running={conversation.runState === "running"}
                  canFork={Boolean(AGENTS[conversation.agent].fork && conversation.sessionId) && !running}
                  canResend={!running && !column && !conversation.compareId}
                  highlightedRowId={searchTarget?.rowId ?? null}
                />
              )}
            </div>
          </div>
          {showJump ? (
            <Button
              variant="outline"
              size="icon-md"
              className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-background shadow-md"
              onClick={() => {
                stickRef.current = true;
                scrollToBottom("smooth");
              }}
            >
              <ArrowDownIcon />
            </Button>
          ) : null}
        </div>
        <div className={cn("shrink-0", column ? "px-3" : "mx-auto w-full max-w-3xl px-6 pb-4")}>
          <TaskListPanel conversation={conversation} />
          {column ? null : (
            <Composer
              key={conversation.viewId}
              conversation={conversation}
              onSubmitted={() => {
                stickRef.current = true;
                scrollToBottom();
              }}
            />
          )}
        </div>
      </div>
    </FilePreviewProvider>
  );
}
