// Development: build the main process and preload, serve the renderer with
// Vite (hot reload), and launch Electron against it.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electronPath from "electron";
import { build, createServer } from "vite";

const root = resolve(import.meta.dirname, "..");
process.chdir(root);

for (const mode of ["main", "preload"]) {
  await build({ configFile: resolve(root, "vite.main.config.ts"), mode, logLevel: "warn" });
}
const server = await createServer({ configFile: resolve(root, "vite.config.ts") });
await server.listen();
const url = server.resolvedUrls?.local[0] ?? "http://127.0.0.1:5174/";
console.log(`renderer at ${url}`);

const electron = spawn(electronPath as unknown as string, ["."], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, EDITOR_DEV_URL: url },
});
electron.on("exit", (code) => {
  void server.close().then(() => process.exit(code ?? 0));
});
