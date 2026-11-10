import "./app/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FloatingApp } from "./app/floating/FloatingApp";

document.documentElement.classList.add("platform-mac-desktop", "floating-window");
createRoot(document.getElementById("root")!).render(<StrictMode><FloatingApp /></StrictMode>);
