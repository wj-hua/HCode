// 远程页面顶部的连接提示：区分“已断开”与“正在补齐会话内容”，短暂的重连与同步不打扰用户。
import { useEffect, useState } from "react";
import type { RemoteConnectionState } from "../remoteBridge";

/** 网络正常时重连、同步通常在此时间内完成，超过才提示，避免横幅闪烁。 */
const TRANSIENT_DELAY_MS = 1500;

type BannerState = Exclude<RemoteConnectionState, "connected">;

const MESSAGES: Record<BannerState, string> = {
  disconnected: "与电脑的连接已中断，正在自动重连…",
  connecting: "正在连接电脑…",
  syncing: "已连接，正在同步会话内容…",
};

export function RemoteConnectionBanner({ connection }: { connection: RemoteConnectionState }) {
  // 已显示的提示保留到新状态满足显示条件，从“已中断”转入重连时不会先消失再出现。
  const [visible, setVisible] = useState<BannerState | null>(null);

  useEffect(() => {
    if (connection === "connected") {
      setVisible(null);
      return;
    }
    if (connection === "disconnected") {
      setVisible(connection);
      return;
    }
    const timer = setTimeout(() => setVisible(connection), TRANSIENT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [connection]);

  if (!visible) return null;
  return <div role="status" className="fixed inset-x-0 top-0 z-50 bg-background p-2 text-center text-ui-base text-foreground shadow-sm">
    {MESSAGES[visible]}
  </div>;
}
