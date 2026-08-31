import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { resolveEndpoints } from "./src/shared/endpoints";

const here = fileURLToPath(new URL(".", import.meta.url));
const r = (p: string) => resolve(here, p);

/**
 * Derive the renderer's CSP connect-src/img-src from the SAME endpoint
 * resolution the app itself uses, and substitute it into index.html.
 *
 * The CSP used to hardcode the hosted origin while src/shared/endpoints.ts
 * documented that "a custom deployment needs no code edit" via VITE_* overrides.
 * Both could not be true: repointing a build produced one whose every request
 * was blocked by CSP, with no build-time warning and a runtime failure that
 * looks like a network outage. Generating the directive from the resolved
 * endpoints makes the override actually work and keeps the allowlist tight.
 */
function cspPlugin(isProd: boolean, env: Record<string, string | undefined>) {
  return {
    name: "taskboard-csp",
    transformIndexHtml: {
      order: "pre" as const,
      handler(html: string) {
        const e = resolveEndpoints(isProd, {
          authBase: env.VITE_AUTH_BASE,
          taskBase: env.VITE_TASK_BASE,
          notificationBase: env.VITE_NOTIFICATION_BASE,
          messagingBase: env.VITE_MESSAGING_BASE,
          wsUrl: env.VITE_WS_URL,
        });
        const origins = new Set<string>();
        for (const url of Object.values(e)) {
          try {
            origins.add(new URL(url).origin);
          } catch {
            /* a malformed override simply contributes nothing to the allowlist */
          }
        }
        // Dev also loads from the Vite server and may hot-reload over ws://.
        if (!isProd) {
          origins.add("http://localhost:*");
          origins.add("ws://localhost:*");
        }
        const connect = [...origins].sort().join(" ");
        // Images come from the API origins only (avatars, attachments) — the ws
        // origin is irrelevant here but harmless, and keeping one list keeps the
        // two directives from drifting apart.
        const img = [...origins].filter((o) => o.startsWith("http")).sort().join(" ");
        // Video and audio attachments stream from the SAME API origins as
        // images. media-src has no fallback to img-src — it falls back to
        // default-src ('self') — so without its own directive every <video> in
        // a chat is blocked with a console-only violation and no UI signal.
        const media = img;
        // replaceAll, not replace: the explanatory comment above the meta tag
        // names the placeholders, so a first-match-only replace would patch the
        // comment and leave the actual directive untouched.
        return html
          .replaceAll("%CSP_CONNECT_SRC%", connect)
          .replaceAll("%CSP_IMG_SRC%", img)
          .replaceAll("%CSP_MEDIA_SRC%", media);
      },
    },
  };
}

export default defineConfig({
  main: {
    // Baked into the bundle so a packaged app launched from the Dock or Start
    // menu — which inherits no shell environment — still has it. geo-key.ts
    // still prefers process.env.TB_GOOGLE_API_KEY at runtime when one is set.
    // Absent is a supported configuration: location sharing then falls back to
    // the server's IP lookup instead of a precise fix.
    define: {
      __TB_GOOGLE_API_KEY__: JSON.stringify(process.env.TB_GOOGLE_API_KEY ?? ""),
    },
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
    plugins: [
      react(),
      tailwindcss(),
      cspPlugin(process.env.NODE_ENV === "production", process.env),
    ],
    build: {
      // electron-vite defaults `minify` to false — unlike plain `vite build`,
      // which minifies in production. The renderer had been shipping unminified
      // (1.1 MB / 30k readable lines vs the web app's 768 KB), which cost cold
      // start and put fully commented source — including the notes describing
      // the security model — inside app.asar, where `asar: true` is not a
      // protection. Main/preload stay unminified on purpose: that's
      // electron-vite's default and it keeps crash traces legible.
      minify: "esbuild",
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
