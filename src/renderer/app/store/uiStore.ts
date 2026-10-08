// 界面设置（主题、代码预览），同时供 ZCode 组件经 useZCodeStore shim 读取。
import { create } from "zustand";
import { DEFAULT_CODE_PREVIEW_SETTINGS, type CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import { applyTheme, type Theme } from "@/useTheme.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

type SidePanelState =
  | { type: "diff"; viewId: string }
  | { type: "file"; viewId: string; source: CodeViewerSource };

interface UiState {
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  sidePanel: SidePanelState | null;
  setSidePanel(panel: SidePanelState | null): void;
  setTheme(theme: "system" | "light" | "dark"): void;
}

let mediaListener: (() => void) | null = null;

export const useUiStore = create<UiState>((set) => ({
  theme: "system",
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sidePanel: null,
  setSidePanel: (sidePanel) => set({ sidePanel }),
  setTheme(pref) {
    const theme: Theme = pref === "dark" ? "zai-dark" : pref === "light" ? "zai-light" : "system";
    applyTheme(theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mediaListener) mq.removeEventListener("change", mediaListener);
    mediaListener = null;
    if (theme === "system") {
      mediaListener = () => applyTheme("system");
      mq.addEventListener("change", mediaListener);
    }
    set({ theme });
  },
}));
