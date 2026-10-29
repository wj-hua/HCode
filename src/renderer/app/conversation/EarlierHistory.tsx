// 远程历史入口：立即展示加载/失败状态，补页时由会话滚动控制保留阅读位置。
import { Button } from "@/components/ui/button.js";
import { useAppStore, type Conversation } from "../store/appStore";

export function EarlierHistory({ conversation, beforeLoad }: { conversation: Conversation; beforeLoad(): void }) {
  if (!conversation.earlierRows) return null;
  return <div className="mb-5 flex flex-col items-center gap-2">
    <Button variant="ghost" disabled={conversation.earlierRowsLoading} aria-busy={!!conversation.earlierRowsLoading} onClick={() => {
      beforeLoad();
      void useAppStore.getState().loadEarlierHistory(conversation.viewId);
    }}>{conversation.earlierRowsLoading ? "正在读取更早消息…" : "加载更早消息"}</Button>
    {conversation.earlierRowsError ? <p role="alert" className="text-ui-sm text-destructive">读取失败：{conversation.earlierRowsError}，可再次点击重试。</p> : null}
  </div>;
}
