// 回合进行中插话（turn steer）：能投递时消息直接进入当前回合；不能投递时退回待发送队列，内容不丢失。
// 是否真正可投递由主进程按 CLI 能力和原生回合状态判定，这里只排除注定无法插话的输入。
import { AGENTS } from "@hcode/shared/agents";
import type { ChatSteerResult } from "@hcode/shared/types";
import type { AppState, Conversation, QueuedMessage } from "./appStore";
import { hcode } from "../bridge";
import { toast } from "@/components/ui/toast.js";

type PatchConversation = (id: string, update: Partial<Conversation>) => void;
type ReturnToQueue = (viewId: string, message: QueuedMessage) => void;

/** 斜杠命令在 CLI 里作为独立回合执行，插进当前回合只会被当成普通文字，所以保持排队。 */
export function canSteer(conv: Conversation, text: string): boolean {
  const running = conv.runState === "running" || conv.runState === "awaitingApproval";
  return running && Boolean(conv.sessionKey) && !conv.compareId && AGENTS[conv.agent].steer === true && !text.trimStart().startsWith("/");
}

/**
 * 发起插话并等待主进程结算（Claude 要等到下一个工具间隙）。等待期间消息显示在“正在引导”列表；
 * 未投递时提示原因并交回待发送队列，会话已空闲时由队列立即补发。
 */
export async function steerConversation(
  viewId: string,
  message: QueuedMessage,
  get: () => AppState,
  patch: PatchConversation,
  returnToQueue: ReturnToQueue,
): Promise<void> {
  const conv = get().conversations[viewId];
  if (!conv?.sessionKey) return;
  patch(viewId, { steering: [...(conv.steering ?? []), message] });
  let result: ChatSteerResult;
  try {
    result = await hcode.invoke("chat:steer", {
      sessionKey: conv.sessionKey,
      text: message.text,
      ...(message.images.length ? { images: message.images } : {}),
      ...(message.files.length ? { files: message.files } : {}),
    });
  } catch (error) {
    // 通道或会话异常同样按“未投递”处理：内容回到队列，原因可见
    result = { delivered: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const current = get().conversations[viewId];
  if (!current) return;
  patch(viewId, { steering: (current.steering ?? []).filter((item) => item.id !== message.id) });
  if (result.delivered) return;
  toast(`未能插话，已加入待发送队列：${result.reason}`, { variant: "info" });
  returnToQueue(viewId, message);
}
