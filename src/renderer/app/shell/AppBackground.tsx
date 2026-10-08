// 应用背景：图片/视频铺满窗口，上面叠一层可调的模糊蒙层。
import { isBackgroundVideo } from "@hcode/shared/types";
import { useAppStore } from "../store/appStore";

export function AppBackground() {
  const { path, blur, mask } = useAppStore((state) => state.settings.background);
  if (!path) return null;
  // 查询串仅用于换文件时让浏览器重新加载；主进程只认设置里的当前文件。
  const src = `hcode-media://background/?p=${encodeURIComponent(path)}`;
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" aria-hidden>
      {isBackgroundVideo(path) ? (
        <video key={src} src={src} className="size-full object-cover" autoPlay loop muted playsInline />
      ) : (
        <img key={src} src={src} className="size-full object-cover" alt="" draggable={false} />
      )}
      <div
        className="absolute inset-0"
        style={{
          backdropFilter: `blur(${blur}px)`,
          backgroundColor: `color-mix(in oklab, var(--color-background) ${mask}%, transparent)`,
        }}
      />
    </div>
  );
}
