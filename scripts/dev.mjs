// 开发模式：Vite（渲染进程 HMR）+ tsup --watch（主进程/preload）+ Electron（主进程产物变化时重启）
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const electronPath = require("electron");

const vite = await createServer({ configFile: `${root}/vite.config.ts` });
await vite.listen();
const devUrl = vite.resolvedUrls.local[0];
console.log(`[dev] renderer: ${devUrl}`);

const tsup = spawn("pnpm", ["exec", "tsup", "--watch"], { cwd: root, stdio: "inherit" });

let electron = null;
let restartTimer = null;
function startElectron() {
  // HCODE_CDP_PORT=9229 pnpm dev：开启 Chrome DevTools 远程调试，便于截图与读取控制台
  const args = process.env.HCODE_CDP_PORT ? [`--remote-debugging-port=${process.env.HCODE_CDP_PORT}`, "."] : ["."];
  electron = spawn(electronPath, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, HCODE_DEV_SERVER_URL: devUrl },
  });
  electron.on("exit", (code, signal) => {
    if (signal !== "SIGTERM") shutdown(code ?? 0);
  });
}
function restartElectron() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (electron) {
      electron.removeAllListeners("exit");
      electron.kill("SIGTERM");
    }
    startElectron();
  }, 400);
}
function shutdown(code) {
  tsup.kill();
  void vite.close();
  process.exit(code);
}

// 等首次构建完成后启动，之后每次 main/preload 产物变化就重启
const waitFirstBuild = setInterval(async () => {
  const { existsSync } = await import("node:fs");
  if (existsSync(`${root}/out/main/index.js`) && existsSync(`${root}/out/preload/index.cjs`)) {
    clearInterval(waitFirstBuild);
    startElectron();
    watch(`${root}/out/main`, restartElectron);
    watch(`${root}/out/preload`, restartElectron);
  }
}, 300);

process.on("SIGINT", () => shutdown(0));
