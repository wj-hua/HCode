// 协作面板宽度规则；宽窗口保留消息阅读空间，窄窗口采用可关闭的覆盖面板。
export const PANEL_LAYOUT = {
  defaultWidth: 480,
  minWidth: 320,
  minConversationWidth: 360,
  splitThreshold: 832,
  overlayRatio: 0.85,
  keyboardStep: 24,
  storageKey: 'hcode:collaboration-panel-width',
} as const;

export function panelWidthBounds(workspaceWidth: number) {
  const max = Math.max(0, workspaceWidth >= PANEL_LAYOUT.splitThreshold
    ? workspaceWidth - PANEL_LAYOUT.minConversationWidth
    : workspaceWidth * PANEL_LAYOUT.overlayRatio);
  return { min: Math.min(PANEL_LAYOUT.minWidth, max), max };
}

export function constrainPanelWidth(width: number, workspaceWidth: number) {
  const bounds = panelWidthBounds(workspaceWidth);
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}
