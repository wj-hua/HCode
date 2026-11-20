// Chrome 风格重启恢复提示气泡：非阻塞悬浮于工作区右上角，不抢占输入框焦点。
import { HistoryIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useAppStore } from "../store/appStore";

export function TabRestorePrompt() {
  const pending = useAppStore((state) => state.pendingRestoreTabs);
  const restorePendingTabs = useAppStore((state) => state.restorePendingTabs);
  const dismissPendingRestoreTabs = useAppStore((state) => state.dismissPendingRestoreTabs);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);

  if (!pending || pending.items.length === 0) return null;

  const count = pending.items.length;
  const previewTitles = pending.items.slice(0, 2).map((item) => item.title || "新会话");
  const previewText = count > 2 ? `${previewTitles.join("、")} 等` : previewTitles.join("、");

  return (
    <aside
      role="status"
      aria-label="恢复上次打开的会话"
      className="absolute top-3 right-4 z-30 w-[320px] rounded-xl border border-border bg-popover/95 p-3.5 text-foreground shadow-lg backdrop-blur-xs"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <HistoryIcon className="size-4 shrink-0 text-primary" />
          <span className="text-ui-base font-medium text-foreground">恢复上次打开的会话？</span>
        </div>
        <button
          type="button"
          aria-label="关闭恢复提示"
          onClick={dismissPendingRestoreTabs}
          className="flex size-5 shrink-0 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      <div className="mt-1.5 flex flex-col gap-0.5 pl-6">
        <p className="text-ui-sm text-foreground-subtle">
          上次关闭前打开了 {count} 个会话标签
        </p>
        <p className="truncate text-ui-xs text-foreground-subtlest" title={previewText}>
          {previewText}
        </p>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setSettingsOpen(true, "general")}
          className="text-ui-xs text-foreground-subtle transition-colors hover:text-foreground cursor-pointer"
        >
          启动设置
        </button>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={dismissPendingRestoreTabs}>
            暂不
          </Button>
          <Button type="button" variant="default" size="sm" onClick={() => void restorePendingTabs()}>
            恢复
          </Button>
        </div>
      </div>
    </aside>
  );
}
