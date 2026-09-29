// HCode shim：界面模式以 HCode 持久化设置为唯一状态源。
import { useAppStore } from "@app/store/appStore";

export function useIsOfficeMode(): boolean {
  return useAppStore((state) => state.settings.interfaceMode === "office");
}
