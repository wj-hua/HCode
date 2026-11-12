"use client";

import { useEffect, useRef, useState } from "react";
import { formatDuration } from "../format";

// 移植自 ZCode chat-loading：旋转点阵球周期性聚成 HCode 的 "H"。
// 球面密度独立于 H 点阵，避免调整字形间距时意外改变球体；动画几何只生成一次。
const ORB_H_POINTS = [
  [3, 4],
  [5, 4],
  [15, 4],
  [17, 4],
  [3, 6],
  [5, 6],
  [15, 6],
  [17, 6],
  [3, 8],
  [5, 8],
  [15, 8],
  [17, 8],
  [3, 10],
  [5, 10],
  [7, 10],
  [9, 10],
  [11, 10],
  [13, 10],
  [15, 10],
  [17, 10],
  [3, 12],
  [5, 12],
  [15, 12],
  [17, 12],
  [3, 14],
  [5, 14],
  [15, 14],
  [17, 14],
  [3, 16],
  [5, 16],
  [15, 16],
  [17, 16],
] as const;
const ORB_POINT_COUNT = 105;
const ORB_H_TARGETS = new Map(
  ORB_H_POINTS.map((point, index) => [
    Math.floor((index * ORB_POINT_COUNT) / ORB_H_POINTS.length),
    point,
  ]),
);
const ORB_SPHERE = Array.from({ length: ORB_POINT_COUNT }, (_, index) => {
  const y = 1 - (index / (ORB_POINT_COUNT - 1)) * 2;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = Math.PI * (3 - Math.sqrt(5)) * index;
  return [Math.cos(theta) * radius, y, Math.sin(theta) * radius] as const;
});
const easeOrbMorph = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function ChatLoadingOrbs() {
  const groupRef = useRef<SVGGElement>(null);
  useEffect(() => {
    const dots = Array.from(groupRef.current?.querySelectorAll("circle") ?? []);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frameId = 0;
    let startedAt = performance.now();
    const setDot = (dot: SVGCircleElement, x: number, y: number, r: number, opacity: number) => {
      dot.setAttribute("cx", x.toFixed(2));
      dot.setAttribute("cy", y.toFixed(2));
      dot.setAttribute("r", r.toFixed(2));
      dot.setAttribute("opacity", opacity.toFixed(2));
    };
    const frame = (now: number) => {
      const elapsed = (now - startedAt) % 8240;
      // 只延长纯球体阶段，保留原有变形速度与 H 停留时间。
      const morph =
        elapsed < 5000
          ? 0
          : elapsed < 6296
            ? easeOrbMorph((elapsed - 5000) / 1296)
            : elapsed < 7160
              ? 1
              : elapsed < 7952
                ? 1 - easeOrbMorph((elapsed - 7160) / 792)
                : 0;
      const angle = (now / 2500) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      dots.forEach((dot, index) => {
        const sphere = ORB_SPHERE[index];
        const target = ORB_H_TARGETS.get(index);
        if (!sphere) return;
        const [sx, sy, sz] = sphere;
        const orbX = 10 + 8.5 * (sx * cos + sz * sin);
        const orbY = 10 - 8.5 * sy;
        const depth = (-sx * sin + sz * cos + 1) / 2;
        const orbOpacity = index % 3 === 0 ? 0.35 + 0.6 * depth : 0;
        const stagger =
          morph === 0 || morph === 1
            ? morph
            : Math.max(0, Math.min(1, morph + (index / dots.length - 0.5) * 0.06));
        const [zx, zy] = target ?? [orbX, orbY];
        const dx = zx - orbX;
        const dy = zy - orbY;
        const length = Math.hypot(dx, dy) || 1;
        const arc = Math.sin(Math.PI * stagger) * 0.45 * (index % 2 ? 1 : -1);
        setDot(
          dot,
          orbX + dx * stagger - (dy / length) * arc,
          orbY + dy * stagger + (dx / length) * arc,
          0.5,
          orbOpacity + ((target ? 1 : 0) - orbOpacity) * stagger,
        );
      });
      frameId = window.requestAnimationFrame(frame);
    };
    const updateMotion = () => {
      window.cancelAnimationFrame(frameId);
      if (reducedMotion.matches) {
        dots.forEach((dot, index) => {
          const target = ORB_H_TARGETS.get(index);
          const [x, y] = target ?? [10, 10];
          setDot(dot, x, y, 0.5, target ? 1 : 0);
        });
      } else {
        startedAt = performance.now();
        frameId = window.requestAnimationFrame(frame);
      }
    };
    updateMotion();
    reducedMotion.addEventListener("change", updateMotion);
    return () => {
      window.cancelAnimationFrame(frameId);
      reducedMotion.removeEventListener("change", updateMotion);
    };
  }, []);
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="size-5 shrink-0 overflow-visible text-brand"
    >
      <g
        ref={groupRef}
        fill="currentColor"
        style={{
          filter: "drop-shadow(0 0 0.2px color-mix(in srgb, currentColor 25%, transparent))",
        }}
      >
        {ORB_SPHERE.map((_, index) => {
          const target = ORB_H_TARGETS.get(index);
          return (
            <circle
              key={index}
              cx={target?.[0] ?? 10}
              cy={target?.[1] ?? 10}
              r={0.5}
              opacity={target ? 1 : 0}
            />
          );
        })}
      </g>
    </svg>
  );
}

/** 运行中提示：点阵球 + 流光“工作中” + 计时；startedAt 为本轮开始时间，切换会话后计时不重置。 */
export function ChatLoading({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div role="status" aria-label="工作中" data-zcode-chat-loading-animate="true" className="inline-flex w-fit items-center gap-2">
      <span className="flex size-4 shrink-0 items-center justify-center">
        <ChatLoadingOrbs />
      </span>
      <span className="animated-gradient-text text-ui-base motion-reduce:animate-none!">工作中</span>
      {startedAt ? (
        <span aria-hidden="true" className="font-mono text-ui-caption tabular-nums text-foreground-subtle">
          {formatDuration(Math.max(0, now - startedAt))}
        </span>
      ) : null}
    </div>
  );
}
