// 应用背景：图片/视频铺满窗口，上面叠一层可调的模糊蒙层。
import { isBackgroundVideo } from "@hcode/shared/types";
import { useAppStore } from "../store/appStore";
import { useReducedMotion } from "motion/react";

export function AppBackground() {
  const { path, blur, mask } = useAppStore((state) => state.settings.background);
  const reducedMotion = useReducedMotion();
  if (!path) return null;
  // 查询串仅用于换文件时让浏览器重新加载；主进程只认设置里的当前文件。
  const src = `hcode-media://background/?p=${encodeURIComponent(path)}`;
  // 直接模糊媒体本身而不用 backdrop-filter：透明 + vibrancy 窗口里，上层内容重绘或滚动时
  // 全窗口 backdrop-filter 会掉帧，蒙层和模糊一起闪没。放大一点遮住模糊后的透明边缘。
  const mediaStyle = blur ? { filter: `blur(${blur}px)`, transform: "scale(1.1)" } : undefined;
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>
      {isBackgroundVideo(path) ? (
        <video key={`${src}:${Boolean(reducedMotion)}`} src={src} className="size-full object-cover" style={mediaStyle} autoPlay={!reducedMotion} loop muted playsInline />
      ) : (
        <img key={src} src={src} className="size-full object-cover" style={mediaStyle} alt="" draggable={false} />
      )}
      <div
        className="absolute inset-0"
        style={{ backgroundColor: `color-mix(in oklab, var(--color-background) ${mask}%, transparent)` }}
      />
    </div>
  );
}
