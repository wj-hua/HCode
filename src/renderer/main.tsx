import "./app/app.css";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { remoteBridge } from "./app/bridge";
import { RemoteLogin } from "./app/remote/RemoteLogin";
import { RemoteUnauthorizedError } from "./app/remoteBridge";

document.documentElement.classList.add(remoteBridge ? "remote-control" : "platform-mac-desktop");

const render = (node: ReactNode) => createRoot(document.getElementById("root")!).render(<StrictMode>{node}</StrictMode>);

if (!remoteBridge) {
  render(<App />);
} else {
  remoteBridge.connect().then(
    () => render(<App />),
    (error: unknown) => render(error instanceof RemoteUnauthorizedError
      ? <RemoteLogin />
      : <div className="p-6">无法连接电脑上的 HCode：{error instanceof Error ? error.message : String(error)}</div>),
  );
}
