// 窄屏远程页面：横向右滑打开侧边栏任务列表，左滑收起。
import { useEffect } from "react";
import { useAppStore } from "../store/appStore";

const LOCK_DISTANCE = 10;
const TOGGLE_DISTANCE = 56;

// 代码块、表格等可横向滚动的区域保留原本的滑动行为。
function inHorizontalScroller(target: EventTarget | null): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}

export function useSidebarSwipe(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number } | null = null;
    let horizontal = false;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      const target = event.target instanceof Element ? event.target : null;
      start = event.touches.length === 1 && touch && !target?.closest('[role="dialog"]') && !inHorizontalScroller(target)
        ? { x: touch.clientX, y: touch.clientY }
        : null;
      horizontal = false;
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!horizontal) {
        if (Math.abs(dx) < LOCK_DISTANCE && Math.abs(dy) < LOCK_DISTANCE) return;
        // 先判定为纵向滚动的手势不再切换侧边栏
        if (Math.abs(dx) < Math.abs(dy) * 1.5) { start = null; return; }
        horizontal = true;
      }
      if (Math.abs(dx) < TOGGLE_DISTANCE) return;
      const state = useAppStore.getState();
      if (dx > 0 && state.sidebarCollapsed) state.setSidebarCollapsed(false);
      else if (dx < 0 && !state.sidebarCollapsed) state.setSidebarCollapsed(true);
      start = null;
    };
    const onEnd = () => { start = null; };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled]);
}
