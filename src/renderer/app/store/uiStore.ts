// 界面设置（主题、代码预览），同时供 ZCode 组件经 useZCodeStore shim 读取。
import { PANEL_LAYOUT } from "../conversation/panelLayout";
import type { ExpertClaimRef } from "@hcode/shared/experts";
import { create } from "zustand";
import { DEFAULT_CODE_PREVIEW_SETTINGS, type CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import { applyTheme, type Theme } from "@/useTheme.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

type SidePanelState =
  | { type: "collaboration"; viewId: string; intent?: "plan" | "records"; runId?: string; citation?: ExpertClaimRef & { label: string } }
  | { type: "terminal"; viewId: string; workspacePath: string }
  | { type: "file"; viewId: string; source: CodeViewerSource };

interface UiState {
  panelWidth: number;
  setPanelWidth(width: number): void;
  theme: Theme;
  codePreviewSettings: CodePreviewSettings;
  sidePanel: SidePanelState | null;
  returnPanel: SidePanelState | null;
  setSidePanel(panel: SidePanelState | null): void;
  setTheme(theme: "system" | "light" | "dark"): void;
}

/** 返回目标只属于打开证据的同一会话；关闭或跨会话导航立即撤销。 */
function returnToCollaboration(next: SidePanelState | null, current: SidePanelState | null, previous: SidePanelState | null) {
  if (!next || next.type === "collaboration") return null;
  if (current?.type === "collaboration" && current.viewId === next.viewId) return current;
  return previous?.viewId === next.viewId ? previous : null;
}

let mediaListener: (() => void) | null = null;

export const useUiStore = create<UiState>((set) => ({
  panelWidth: PANEL_LAYOUT.defaultWidth,
  setPanelWidth: panelWidth => set({ panelWidth }),
  theme: "system",
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sidePanel: null,
  returnPanel: null,
  setSidePanel: (sidePanel) => set(state => ({
    sidePanel,
    returnPanel: returnToCollaboration(sidePanel, state.sidePanel, state.returnPanel),
  })),
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
