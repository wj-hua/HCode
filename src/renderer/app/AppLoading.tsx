// 启动和按需模块下载期间的轻量反馈，不依赖完整界面、词典或 Markdown 渲染器。
export function AppLoading() {
  return <div role="status" className="flex h-dvh items-center justify-center bg-background text-ui-base text-foreground-subtle">正在加载 HCode…</div>;
}
