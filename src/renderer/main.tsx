import "./app/app.css";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { remoteBridge } from "./app/bridge";
import { RemoteApp } from "./app/remote/RemoteApp";

document.documentElement.classList.add(remoteBridge ? "remote-control" : "platform-mac-desktop");

const render = (node: ReactNode) => createRoot(document.getElementById("root")!).render(<StrictMode>{node}</StrictMode>);

if (!remoteBridge) {
  render(<App />);
} else {
  render(<RemoteApp />);
}
