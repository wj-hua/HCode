import "./app/app.css";
import { StrictMode, Suspense, lazy, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { remoteBridge } from "./app/bridge";
import { AppLoading } from "./app/AppLoading";
import { AppLoadBoundary } from "./app/AppLoadBoundary";

const App = lazy(() => import("./app/App").then(module => ({ default: module.App })));
const RemoteApp = lazy(() => import("./app/remote/RemoteApp").then(module => ({ default: module.RemoteApp })));

document.documentElement.classList.add(remoteBridge ? "remote-control" : "platform-mac-desktop");

const render = (node: ReactNode) => createRoot(document.getElementById("root")!).render(<StrictMode><AppLoadBoundary><Suspense fallback={<AppLoading />}>{node}</Suspense></AppLoadBoundary></StrictMode>);

if (!remoteBridge) {
  render(<App />);
} else {
  render(<RemoteApp />);
}
