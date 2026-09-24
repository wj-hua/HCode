import { defineConfig } from "tsup";

const shared = {
  platform: "node" as const,
  target: "node22",
  sourcemap: true,
  external: ["electron"],
  // 保留 node: 前缀：node:sqlite 只能带前缀导入
  removeNodeProtocol: false,
  // SDK 只依赖 Node 内置模块，打进 main 包；运行时通过 pathToClaudeCodeExecutable 使用用户安装的 claude
  noExternal: [/^@zcode\//, /^@hcode\//, /^@anthropic-ai\//],
  esbuildOptions(options: { alias?: Record<string, string> }) {
    options.alias = { ...options.alias, "@hcode/shared": "./src/shared" };
  },
};

export default defineConfig([
  { ...shared, entry: { index: "src/main/index.ts" }, outDir: "out/main", format: "esm", clean: true },
  // preload 在 sandbox 下只能是 CommonJS
  { ...shared, entry: { index: "src/preload/index.ts" }, outDir: "out/preload", format: "cjs", clean: true },
]);
