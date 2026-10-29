// 手动刷新入口复用宿主按钮和状态；窄屏始终可见，错误保留原内容并允许重试。
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useAppStore, type Conversation } from "../store/appStore";

const BUTTON_CLASS = "app-no-drag shrink-0 text-foreground-subtle pointer-coarse:min-h-11 pointer-coarse:min-w-11";
export function RefreshSessionListButton() {
  const loading = useAppStore(state => state.sessionListRefreshing);
  const refresh = useAppStore(state => state.refreshSessionList);
  return <ControlHintTooltip title={loading ? "正在刷新会话列表" : "刷新会话列表"} side="bottom"><Button variant="ghost" size="icon-md" className={BUTTON_CLASS} aria-label="刷新会话列表" aria-busy={loading} disabled={loading} onClick={() => void refresh()}><RefreshCwIcon className={loading ? "animate-spin motion-reduce:animate-none" : ""} /></Button></ControlHintTooltip>;
}
export function RefreshConversationButton({ conversation }: { conversation: Conversation }) {
  const refresh = useAppStore(state => state.refreshConversation);
  const loading = !!conversation.refreshing;
  if (!conversation.sessionId && !conversation.sessionKey) return null;
  return <div className="app-no-drag flex shrink-0 items-center">
    {conversation.refreshError ? <span role="alert" className="max-w-32 truncate text-ui-xs text-destructive" title={conversation.refreshError}>刷新失败，请重试</span> : null}
    <ControlHintTooltip title={conversation.refreshError ?? (loading ? "正在刷新当前会话" : "刷新当前会话")} side="bottom"><Button variant="ghost" size="icon-md" className={BUTTON_CLASS} aria-label="刷新当前会话" aria-busy={loading} disabled={loading || conversation.loading || conversation.earlierRowsLoading} onClick={() => void refresh(conversation.viewId)}><RefreshCwIcon className={loading ? "animate-spin motion-reduce:animate-none" : ""} /></Button></ControlHintTooltip>
  </div>;
}
