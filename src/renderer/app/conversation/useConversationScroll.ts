// 会话阅读位置只跟随真实用户意图；完整报告到达时定位结论开头，向上阅读不被打断。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CollaborationPresentation } from '@hcode/shared/collaborationPresentation';
import type { Conversation } from '../store/appStore';
const STICK_THRESHOLD_PX = 80;
export function useConversationScroll(conversation: Conversation, latest: CollaborationPresentation | undefined, searchTarget: { rowId: number | null; key: number } | null) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const revealedResult = useRef<string | undefined>(undefined);
  const stickRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const prependPosition = useRef<{ top: number; height: number } | null>(null);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : behavior });
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

  const beforeHistoryLoad = () => {
    const element = scrollRef.current;
    if (!element) return;
    stickRef.current = false;
    prependPosition.current = { top: element.scrollTop, height: element.scrollHeight };
  };
  useLayoutEffect(() => {
    const position = prependPosition.current;
    const element = scrollRef.current;
    if (!position || !element || conversation.earlierRowsLoading) return;
    element.scrollTop = position.top + element.scrollHeight - position.height;
    lastScrollTopRef.current = element.scrollTop;
    prependPosition.current = null;
  }, [conversation.rows, conversation.earlierRowsLoading]);

  // 完整结果一次性到达时先展示结论开头；用户正在向上阅读时只更新内容，不抢位置。
  useLayoutEffect(() => {
    if (conversation.loading || searchTarget?.rowId != null || !latest?.experts?.summary) return;
    const task = latest.tasks.findLast(entry => entry.role === 'synthesis' && entry.status === 'succeeded');
    const key = `${latest.id}:${task?.id ?? 'legacy'}`;
    if (revealedResult.current === key) return;
    const result = contentRef.current?.querySelector(`[data-expert-result="${latest.id}"]`);
    if (!result) return;
    revealedResult.current = key;
    if (!stickRef.current) return;
    stickRef.current = false;
    result.scrollIntoView({ block: 'start' });
  }, [conversation.loading, latest, searchTarget?.rowId]);

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

  const followLatest = (behavior: ScrollBehavior = 'auto') => { stickRef.current = true; scrollToBottom(behavior); };
  return { scrollRef, contentRef, onScroll, showJump, followLatest, beforeHistoryLoad };
}
