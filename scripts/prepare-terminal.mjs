import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const packageDir = dirname(require.resolve("node-pty/package.json"));
  await chmod(join(packageDir, "prebuilds", `darwin-${process.arch}`, "spawn-helper"), 0o755);
}
