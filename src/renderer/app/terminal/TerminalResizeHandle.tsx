import { useRef } from "react";

export function TerminalResizeHandle({ height, setHeight }: { height: number; setHeight: (height: number) => void }) {
  const drag = useRef<{ y: number; height: number } | null>(null);
  const maximum = () => Math.max(140, (document.getElementById("conversation-panels")?.clientHeight ?? 600) / 2);
  const update = (value: number) => setHeight(Math.max(140, Math.min(maximum(), value)));
  return <div role="separator" tabIndex={0} aria-label="调整终端高度" aria-orientation="horizontal" aria-valuemin={140} aria-valuemax={Math.round(maximum())} aria-valuenow={Math.round(height)} className="relative h-1 shrink-0 cursor-row-resize hover:bg-foreground-subtlest/30 focus-visible:bg-foreground-subtlest/30"
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { y: event.clientY, height }; }}
    onPointerMove={event => { if (drag.current) update(drag.current.height + drag.current.y - event.clientY); }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); drag.current = null; }}
    onPointerCancel={() => { drag.current = null; }}
    onKeyDown={event => { const value = event.key === "ArrowUp" ? height + 20 : event.key === "ArrowDown" ? height - 20 : event.key === "Home" ? 140 : event.key === "End" ? maximum() : null; if (value !== null) { event.preventDefault(); update(value); } }} />;
}
