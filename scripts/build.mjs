// 生产构建：tsup（main/preload）+ vite build（renderer）
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
execSync("pnpm exec tsup", { cwd: root, stdio: "inherit" });
execSync("pnpm exec vite build", { cwd: root, stdio: "inherit" });
