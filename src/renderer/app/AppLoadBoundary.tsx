// 按需模块加载失败时保留可操作的错误入口，避免网络波动让远程页面停在空白屏。
import { Component, type ReactNode } from "react";

export class AppLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: Error) { console.error("[hcode-ui] 页面加载失败", error); }
  override render() {
    if (!this.state.failed) return this.props.children;
    return <div role="alert" className="flex h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-foreground">
      <p>页面加载失败，请检查网络后重试。</p>
      <button type="button" className="rounded-md border border-border px-4 py-2 focus-visible:outline" onClick={() => location.reload()}>重新加载</button>
    </div>;
  }
}
