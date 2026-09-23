import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { AppShell } from "./shell/AppShell";
import { useAppStore } from "./store/appStore";

export function App() {
  const init = useAppStore((state) => state.init);
  const locale = useAppStore((state) => state.settings.locale);
  const ready = useAppStore((state) => state.ready);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    // 语言切换时重建 Provider，让 ZCode 组件拿到新的 intl
    <ZCodeIntlProvider key={locale} initialLocale={locale}>
      <TooltipProvider delayDuration={300}>{ready ? <AppShell /> : <div className="h-dvh" />}</TooltipProvider>
    </ZCodeIntlProvider>
  );
}
