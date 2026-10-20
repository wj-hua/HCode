// 文件面板始终分栏；协作面板在窄窗口沿用覆盖布局，两者均限制可调宽度。
export const PANEL_LAYOUT = {
  defaultWidth: 480,
  minWidth: 320,
  minConversationWidth: 360,
  splitThreshold: 832,
  overlayRatio: 0.85,
  narrowSplitRatio: 0.5,
  keyboardStep: 24,
  storageKey: 'hcode:collaboration-panel-width',
} as const;

export function panelWidthBounds(workspaceWidth: number, docked = false) {
  if (docked) {
    const max = Math.max(0, workspaceWidth >= PANEL_LAYOUT.minWidth + PANEL_LAYOUT.minConversationWidth
      ? workspaceWidth - PANEL_LAYOUT.minConversationWidth : workspaceWidth * PANEL_LAYOUT.narrowSplitRatio);
    return { min: Math.min(PANEL_LAYOUT.minWidth, max), max };
  }
  const max = Math.max(0, workspaceWidth >= PANEL_LAYOUT.splitThreshold
    ? workspaceWidth - PANEL_LAYOUT.minConversationWidth
    : workspaceWidth * PANEL_LAYOUT.overlayRatio);
  return { min: Math.min(PANEL_LAYOUT.minWidth, max), max };
}

export function constrainPanelWidth(width: number, workspaceWidth: number, docked = false) {
  const bounds = panelWidthBounds(workspaceWidth, docked);
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}
