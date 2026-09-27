// 输入框上方的待发送队列：文案照 ZCode chat.queue.*。
import { PaperclipIcon, PencilIcon, PlayIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useAppStore, type Conversation, type QueuedMessage } from "../store/appStore";

const PAUSED_TEXT = {
  stopped: "由于你中断了当前响应，队列已暂停",
  error: "由于当前响应出错，队列已暂停（内容未丢失）",
} as const;

export function QueuedMessages({
  conversation,
  onEdit,
}: {
  conversation: Conversation;
  onEdit: (item: QueuedMessage) => void;
}) {
  const removeQueued = useAppStore((state) => state.removeQueued);
  const resumeQueue = useAppStore((state) => state.resumeQueue);
  const { queue, queuePaused } = conversation;
  if (queue.length === 0) return null;

  return (
    <div className="mb-2 rounded-xl border border-border bg-background px-3 py-2 text-ui-sm">
      <div className="flex items-center gap-2 text-foreground-subtle">
        <span className="flex-1">待发送消息（{queue.length}）</span>
        {queuePaused ? (
          <>
            <span className="text-warning">{PAUSED_TEXT[queuePaused]}</span>
            <ControlHintTooltip title="继续按顺序自动发送队列中的内容">
              <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2" onClick={resumeQueue}>
                <PlayIcon className="size-3" />
                继续
              </Button>
            </ControlHintTooltip>
          </>
        ) : null}
      </div>
      <ul className="mt-1 flex flex-col">
        {queue.map((item) => {
          const attachments = item.images.length + item.files.length;
          return (
            <li key={item.id} className="group flex items-center gap-2 rounded-md py-0.5">
              <span className="min-w-0 flex-1 truncate text-foreground" title={item.text}>
                {item.text.trim().split("\n")[0] || "（仅附件）"}
              </span>
              {attachments > 0 ? (
                <span className="flex shrink-0 items-center gap-0.5 text-foreground-subtlest">
                  <PaperclipIcon className="size-3" />
                  {attachments}
                </span>
              ) : null}
              <ControlHintTooltip title="编辑">
                <Button type="button" variant="ghost" size="icon-sm" aria-label="编辑" onClick={() => onEdit(item)}>
                  <PencilIcon />
                </Button>
              </ControlHintTooltip>
              <ControlHintTooltip title="移除待发送消息">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="移除待发送消息"
                  onClick={() => removeQueued(item.id)}
                >
                  <XIcon />
                </Button>
              </ControlHintTooltip>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
