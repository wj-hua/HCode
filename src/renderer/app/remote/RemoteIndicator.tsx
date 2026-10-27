// 本机侧边栏：远程操控开启时显示，点开设置可关闭。
import { SmartphoneIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useAppStore } from "../store/appStore";
import { useRemoteStatus } from "./useRemoteStatus";

export function RemoteIndicator() {
  const status = useRemoteStatus();
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  if (!status || status.state === "off") return null;
  const failed = status.state === "error" || status.tunnel.state === "error";
  const title = status.state === "error"
    ? `远程操控出错：${status.error ?? "未知错误"}`
    : status.tunnel.state === "error" ? `远程隧道出错：${status.tunnel.error ?? "未知错误"}`
    : status.clients > 0 ? `远程操控：${status.clients} 个设备在线` : "远程操控已开启";
  return (
    <ControlHintTooltip title={title} side="top">
      <Button
        variant="ghost"
        size="icon-md"
        aria-label={title}
        className={cn("text-foreground-subtle", status.clients > 0 && "text-primary", failed && "text-warning")}
        onClick={() => setSettingsOpen(true, "remote")}
      >
        <SmartphoneIcon />
      </Button>
    </ControlHintTooltip>
  );
}
