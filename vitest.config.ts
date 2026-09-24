// 单元测试配置：vite.config.ts 的 root 是 src/renderer，主进程测试单独配置。
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@hcode/shared": r("./src/shared") },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
