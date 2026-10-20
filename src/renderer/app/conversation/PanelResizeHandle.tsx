// 本地布局偏好与直接拖拽；Pointer Capture 保证指针离开边界后仍然连续调整。
import { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../store/uiStore';
import { constrainPanelWidth, panelWidthBounds, PANEL_LAYOUT } from './panelLayout';

export function usePanelWidthPreference() {
  const width = useUiStore(state => state.panelWidth);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PANEL_LAYOUT.storageKey);
      if (saved === null) return;
      const value = Number(saved);
      if (!Number.isFinite(value) || value < PANEL_LAYOUT.minWidth) throw new Error('面板宽度记录无效');
      useUiStore.getState().setPanelWidth(value);
    } catch (reason) { console.error('读取协作面板宽度失败', reason); }
  }, []);
  return width;
}

function saveWidth(width: number) {
  try { localStorage.setItem(PANEL_LAYOUT.storageKey, String(width)); }
  catch (reason) { console.error('保存协作面板宽度失败', reason); }
}

export function PanelResizeHandle({ docked = false, label = "调整协作面板宽度" }: { docked?: boolean; label?: string }) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; width: number } | null>(null);
  const width = useUiStore(state => state.panelWidth);
  const setWidth = useUiStore(state => state.setPanelWidth);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  useEffect(() => {
    const workspace = handle.current?.closest('#conversation-panels');
    if (!workspace) return;
    const observer = new ResizeObserver(() => setWorkspaceWidth(workspace.clientWidth));
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);
  const bounds = panelWidthBounds(workspaceWidth, docked);
  const current = constrainPanelWidth(width, workspaceWidth, docked);
  const update = (next: number, persist = false) => {
    const value = constrainPanelWidth(next, workspaceWidth, docked);
    setWidth(value);
    // 窄窗口自动收缩不覆盖用户的桌面偏好。
    if (persist) saveWidth(Math.max(PANEL_LAYOUT.minWidth, value));
  };
  return <div ref={handle} role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuemin={Math.round(bounds.min)} aria-valuemax={Math.round(bounds.max)} aria-valuenow={current} aria-valuetext={`${current} 像素，左右方向键调整，Home 最窄，End 最宽`} className="collaboration-resize-handle app-no-drag"
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, startX: event.clientX, width: current };
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (start?.pointerId === event.pointerId) update(start.width + start.startX - event.clientX);
    }}
    onLostPointerCapture={() => { if (drag.current) saveWidth(Math.max(PANEL_LAYOUT.minWidth, useUiStore.getState().panelWidth)); drag.current = null; }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onDoubleClick={() => update(PANEL_LAYOUT.defaultWidth, true)}
    onKeyDown={event => {
      const next = { ArrowLeft: current + PANEL_LAYOUT.keyboardStep, ArrowRight: current - PANEL_LAYOUT.keyboardStep, Home: bounds.min, End: bounds.max }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      update(next, true);
    }}
  />;
}
