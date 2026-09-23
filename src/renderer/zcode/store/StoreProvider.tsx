// HCode shim：替换 ZCode 原文件（原实现依赖 ZCode 的 services/store 层）。
// ZCode 组件通过 useZCodeStore 读取 theme / codePreviewSettings 等界面设置，这里转接到 HCode 的 uiStore。
import { useCallback, useSyncExternalStore } from "react";
import { useUiStore } from "@app/store/uiStore";
import type { ZCodeState } from "./index.js";

export function useZCodeStore<T>(selector: (state: ZCodeState) => T): T {
  return useUiStore((state) => selector(state as unknown as ZCodeState));
}

export function useZCodeStoreWithDefault<T>(selector: (state: ZCodeState) => T, defaultValue: T): T {
  const subscribe = useCallback((onChange: () => void) => useUiStore.subscribe(onChange), []);
  const getSnapshot = () => {
    try {
      const value = selector(useUiStore.getState() as unknown as ZCodeState);
      return value === undefined ? defaultValue : value;
    } catch {
      return defaultValue;
    }
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
