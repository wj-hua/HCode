import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r("./src/renderer"),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@app": r("./src/renderer/app"),
      "@hcode/shared": r("./src/shared"),
      "@": r("./src/renderer/zcode"),
    },
  },
  server: { port: 5388, strictPort: true },
  build: {
    outDir: r("./out/renderer"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 8000,
  },
});
