import { builtinModules } from "node:module";
import { defineConfig } from "vite";

// Builds the Electron main process and the preload into out/ as CommonJS, one
// file each. Two passes, because a sandboxed preload must be a single file:
//   vite build --config vite.main.config.ts --mode main   (then --mode preload)
export default defineConfig(({ mode }) => {
  const entry = mode === "preload" ? "preload" : "main";
  return {
    build: {
      outDir: "out",
      emptyOutDir: entry === "main",
      ssr: `src/main/${entry}.ts`,
      target: "node22",
      minify: false,
      sourcemap: true,
      rollupOptions: {
        external: ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
        output: { format: "cjs", entryFileNames: `${entry}.cjs` },
      },
    },
    ssr: { noExternal: true },
  };
});
