import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { agentApi } from "./scripts/agentApi.ts";
import { roomsApi } from "./scripts/roomsApi.ts";

// The renderer. `npm run web` serves it on its own (with /api/rooms standing in
// for the Electron bridge); scripts/dev.ts serves it to Electron.
export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  base: "./",
  plugins: [
    react(),
    roomsApi(resolve(import.meta.dirname, "../../rooms"), resolve(import.meta.dirname, "../..")),
    agentApi(resolve(import.meta.dirname, "../../rooms")),
    contentSecurityPolicy(),
  ],
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
  build: {
    outDir: resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "es2023",
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: "es" },
});

/**
 * The built app gets a strict CSP. Development goes without one, because
 * Vite's React refresh injects an inline script.
 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "connect-src 'self'",
  ].join("; ");
  return {
    name: "meridian-csp",
    apply: "build",
    transformIndexHtml: (html) => html.replace("<head>", `<head>
    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}
