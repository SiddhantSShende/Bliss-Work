import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const r = (p: string) => resolve(here, p);

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // `ws` does `require("bufferutil"/"utf-8-validate")` (optional native
        // speedups) inside a try/catch. Externalize them so the bundler keeps
        // the runtime require — ws falls back to pure JS when they're absent.
        // Without this the DEV build turns the unresolved import into a hard
        // `throw`, crashing the ws-process on startup → no WebSocket, no
        // realtime (worked in the prod build, broke only in `npm run desktop`).
        external: ["bufferutil", "utf-8-validate"],
        input: {
          index: r("src/main/index.ts"),
          "ws-process": r("src/main/ws-process.ts"),
        },
        // Build main + ws-process as CommonJS. Electron 33's ESM main entry
        // crashes when it imports the CJS `electron` builtin (Node's ESM loader
        // can't preparse it); CJS sidesteps that entirely. Rollup auto-shims
        // import.meta.url for CJS, so no source changes are needed.
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
          chunkFileNames: "[name].js",
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: r("src/preload/index.ts"),
          sticky: r("src/preload/sticky.ts"),
          "sticky-chat": r("src/preload/sticky-chat.ts"),
        },
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  renderer: {
    root: r("src/renderer"),
    // Pin the renderer dev server to 5174 so it never collides with the web
    // app, which owns 5173 (strictPort). Without this, electron-vite grabs
    // Vite's default 5173 and `npm run web` hard-fails when the desktop is up.
    // The main process loads the renderer via ELECTRON_RENDERER_URL, so this
    // port move needs no source changes.
    server: { port: 5174, strictPort: true },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: r("src/renderer/index.html"),
          sticky: r("src/renderer/sticky.html"),
          "sticky-chat": r("src/renderer/sticky-chat.html"),
        },
      },
    },
  },
});
