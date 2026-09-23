import { ArrowDownIcon, LoaderIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Composer } from "../composer/Composer";
import { useAppStore, type Conversation } from "../store/appStore";
import { Timeline } from "./Timeline";

const STICK_THRESHOLD_PX = 80;

export function ConversationView({ conversation }: { conversation: Conversation }) {
  const permissions = useAppStore((state) => state.permissions);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
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
    return () => observer.disconnect();
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    if (!conversation.loading) scrollToBottom();
  }, [conversation.loading, scrollToBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distance < STICK_THRESHOLD_PX;
    setShowJump(distance > STICK_THRESHOLD_PX * 4);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col px-6 pt-6 pb-10">
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
              <div className="text-ui-lg font-medium text-foreground">和 Claude Code 开始对话</div>
              <div className="text-ui-base text-foreground-subtle">工作目录：{conversation.projectPath}</div>
            </div>
          ) : (
            <Timeline
              rows={conversation.rows}
              workspacePath={conversation.projectPath}
              permissions={permissions}
              running={conversation.runState === "running"}
            />
          )}
        </div>
      </div>
      {showJump ? (
        <Button
          variant="outline"
          size="icon-md"
          className="absolute bottom-40 left-1/2 -translate-x-1/2 rounded-full bg-background shadow-md"
          onClick={() => {
            stickRef.current = true;
            scrollToBottom("smooth");
          }}
        >
          <ArrowDownIcon />
        </Button>
      ) : null}
      <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-4">
        <Composer
          conversation={conversation}
          onSubmitted={() => {
            stickRef.current = true;
            scrollToBottom();
          }}
        />
      </div>
    </div>
  );
}
