import { lazy, Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { AppLoading } from "../AppLoading";
import { remoteBridge } from "../bridge";
import { RemoteUnauthorizedError, type RemoteConnectionState } from "../remoteBridge";
import { RemoteConnectionBanner } from "./RemoteConnectionBanner";
import { RemoteLogin } from "./RemoteLogin";

const App = lazy(() => import("../App").then(module => ({ default: module.App })));

/** 首次打开和断线恢复共用同一 bridge，不刷新已经打开的对话。 */
export function RemoteApp() {
  const [page, setPage] = useState<"connecting" | "login" | "ready">("connecting");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<RemoteConnectionState>("connecting");

  useEffect(() => remoteBridge!.onConnectionChange(setConnection), []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        await remoteBridge!.connect(controller.signal);
        if (!controller.signal.aborted) {
          setError("");
          setPage("ready");
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof RemoteUnauthorizedError) setPage("login");
        else {
          setError(cause instanceof Error ? cause.message : String(cause));
          timer = setTimeout(() => {
            timer = undefined;
            void connect();
          }, 3000);
        }
      }
    };
    const retryOnline = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
        void connect();
      }
    };
    window.addEventListener("online", retryOnline);
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("online", retryOnline);
      remoteBridge!.disconnect();
    };
  }, [attempt]);

  if (page === "login") return <RemoteLogin />;
  if (page === "ready") return <>
    <Suspense fallback={<AppLoading />}><App /></Suspense>
    <RemoteConnectionBanner connection={connection} />
  </>;
  return <div className="flex h-dvh items-center justify-center bg-background p-6 text-foreground">
    <div className="flex max-w-sm flex-col gap-3" role="status">
      <h1 className="text-lg font-medium">HCode 远程操控</h1>
      <p>{error ? "暂时无法连接电脑上的 HCode，正在自动重试…" : "正在连接电脑上的 HCode…"}</p>
      {error ? <>
        <p className="text-ui-base text-foreground-subtle">{error}</p>
        <Button onClick={() => { setError(""); setAttempt((value) => value + 1); }}>立即重试</Button>
      </> : null}
    </div>
  </div>;
}
