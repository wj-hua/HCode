import { subscribePresentation } from "./collaboration/presentationStore";
import { useEffect } from "react";
import { MotionConfig } from "motion/react";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { AppShell } from "./shell/AppShell";
import { useAppStore } from "./store/appStore";
import { useFloatingTasksSync } from "./shell/runningTaskList";

export function App() {
  const init = useAppStore((state) => state.init);
  const refreshAgentStatuses = useAppStore((state) => state.refreshAgentStatuses);
  const locale = useAppStore((state) => state.settings.locale);
  const ready = useAppStore((state) => state.ready);

  useEffect(subscribePresentation, []);
  useFloatingTasksSync();
  useEffect(() => {
    void init();
  }, [init]);
  useEffect(() => {
    if (!ready) return;
    const onFocus = () => void refreshAgentStatuses().catch((error) => console.error("检测 CLI 失败", error));
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ready, refreshAgentStatuses]);

  return (
    // 语言切换时重建 Provider，让 ZCode 组件拿到新的 intl
    <ZCodeIntlProvider key={locale} initialLocale={locale}>
      <MotionConfig reducedMotion="user"><TooltipProvider delayDuration={300}>{ready ? <AppShell /> : <div className="h-dvh" />}</TooltipProvider></MotionConfig>
    </ZCodeIntlProvider>
  );
}
