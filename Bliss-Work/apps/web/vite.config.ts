import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";

/**
 * The service URLs a PRODUCTION bundle cannot be built without.
 *
 * Must stay in sync with REQUIRED_ENV in src/main.tsx — that check is the
 * last-resort backstop for a bundle built by something other than this config;
 * this one is the gate that actually matters.
 */
const REQUIRED_ENV = [
  "VITE_AUTH_BASE",
  "VITE_TASK_BASE",
  "VITE_NOTIFICATION_BASE",
  "VITE_MESSAGING_BASE",
  "VITE_TELEMETRY_BASE",
  "VITE_WS_URL",
] as const;

/**
 * Fail the BUILD when a required service URL is missing, not the browser.
 *
 * src/main.tsx throws on the same condition, but it throws at runtime — which
 * means `npm run build` succeeds, the deploy goes green, nginx serves the
 * bundle, and the first user to load the page gets a blank screen and an
 * uncaught error. That is exactly how VITE_TELEMETRY_BASE shipped broken: the
 * variable was added to the required list and to the client config, the build
 * never complained, and the app died on boot in production.
 *
 * A missing URL is a misconfiguration, and a misconfiguration should stop the
 * pipeline at the earliest point that can see it.
 */
function requireServiceUrls(mode: string): Plugin {
  return {
    name: "blisswork:require-service-urls",
    // `apply: "build"` — a dev server legitimately runs on the localhost
    // fallbacks, and demanding production URLs there would break `npm run web`.
    apply: "build",
    config() {
      if (mode !== "production") return;
      // loadEnv reads .env* files the same way Vite itself does, then we layer
      // process.env over it because CI and the web-builder container pass these
      // as real environment variables rather than files.
      const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
      const missing = REQUIRED_ENV.filter((k) => !env[k]);
      if (missing.length > 0) {
        throw new Error(
          `Refusing to build a production bundle without: ${missing.join(", ")}.\n` +
            "These bake the service URLs into the bundle. Without them the app " +
            "would ship pointing at localhost and fail on first load.\n" +
            "Set them in .env.prod (see .env.prod.example) before building.",
        );
      }
    },
  };
}

// Web shell. Service base URLs are injected via Vite env (VITE_*) with
// localhost defaults matching docker-compose port mappings.

/**
 * One proxied service: strip the /_svc/<name> prefix so the upstream sees the
 * path it actually serves ("/_svc/auth/auth/login" → "/auth/login").
 */
function svc(target: string) {
  return {
    target,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/_svc\/[^/]+/, ""),
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), requireServiceUrls(mode)],
  server: {
    port: 5173,
    strictPort: true,
    // Bind every interface (IPv4 0.0.0.0 AND IPv6 ::), not just whichever
    // address Node's "localhost" resolution happens to pick first on this
    // host. Without this, the dev server was observed binding [::1] (IPv6)
    // only, so a tool/tunnel/port-forward targeting 127.0.0.1 specifically
    // (common for VS Code Remote-SSH, which this proxy setup is explicitly
    // built for — see the comment below) could not reach it at all, even
    // though the server was genuinely up.
    host: true,
    /**
     * Dev-only reverse proxy, so the whole app is reachable through ONE port.
     *
     * The services bind 127.0.0.1 on the dev host. That is fine when the browser
     * runs on that host, but for remote development (VS Code Remote-SSH, an ssh
     * tunnel) it meant forwarding seven ports — and forwarding only 5173 gave the
     * worst possible symptom: the page loads, every request fails, and the login
     * screen blamed the user's password for it.
     *
     * Routing the APIs through the dev server makes them same-origin, so one
     * forwarded port is enough. `server.proxy` applies to `vite dev` only and has
     * no effect on a production build, where the real service URLs come from the
     * VITE_*_BASE variables.
     *
     * Point the client at these prefixes by setting VITE_AUTH_BASE=/_svc/auth
     * (and siblings) — see the localhost fallbacks in src/main.tsx.
     */
    proxy: {
      "/_svc/auth": svc("http://127.0.0.1:8001"),
      "/_svc/task": svc("http://127.0.0.1:8002"),
      "/_svc/notif": svc("http://127.0.0.1:8003"),
      "/_svc/msg": svc("http://127.0.0.1:8004"),
      "/_svc/int": svc("http://127.0.0.1:8005"),
      "/_svc/tel": svc("http://127.0.0.1:8006"),
      // The gateway also serves plain HTTP alongside the socket: presence
      // lookups and short-lived TURN credentials. `presenceBase` is derived
      // from the WS URL (packages/app/src/lib/runtime.tsx), so these have to
      // resolve on the same origin as /ws or every call and avatar goes dark.
      "/presence": { target: "http://127.0.0.1:8090", changeOrigin: true },
      "/turn-credentials": { target: "http://127.0.0.1:8090", changeOrigin: true },
      // The gateway keeps its own path: it is a websocket upgrade, not a REST
      // prefix, and `ws: true` is what makes Vite forward the handshake.
      "/ws": { target: "ws://127.0.0.1:8090", ws: true, changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        /**
         * Vendor chunking.
         *
         * ── What this is and is not for ─────────────────────────────────────
         * This does NOT make the bundle smaller — route splitting in
         * App.tsx does that, and it is the change that matters. This decides
         * how the remaining third-party code is GROUPED, and the reason to
         * care is caching across deploys.
         *
         * Left alone, Rollup folds every dependency into whichever chunk first
         * reaches it, so application code and library code share a file and any
         * change to our own source invalidates React, the router and the query
         * client along with it. Since we deploy far more often than we bump a
         * dependency, that means returning users re-download ~400 KB of
         * unchanged library code on every release.
         *
         * ── Why these groups ────────────────────────────────────────────────
         * Split by CHANGE RATE and by who needs them, not by size:
         *
         *   react   react + react-dom + react-router. Needed before first
         *           paint on every route, changes a few times a year. The
         *           single most cache-worthy thing in the build.
         *   query   @tanstack/react-query. Same argument, separate because it
         *           moves on its own schedule.
         *   charts  framer-motion and the charting deps. Only the analytics
         *           and activity routes need them, and those are already lazy —
         *           naming the group keeps them from being duplicated into
         *           each of those route chunks.
         *
         * Deliberately NOT listed: livekit-client and exceljs. Both are
         * already behind dynamic imports (features/CallRoomLazy and the Excel
         * export), and adding them here would drag them back into the static
         * graph — manualChunks decides placement, it cannot defer loading. A
         * dynamic import is the only thing that does.
         */
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return "react";
          }
          if (id.includes("@tanstack")) return "query";
          if (id.includes("framer-motion")) return "charts";
          return;
        },
      },
    },
    /**
     * The warning threshold, lowered from Rollup's 500 kB default.
     *
     * Set from the EAGER path, which is what a first-time visitor actually
     * waits for: `index` (~239 kB), `react` (~234 kB) and `query` (~47 kB).
     * 350 kB sits above all three, so a regression in any of them — a heavy
     * dependency pulled back into the static graph, a route that loses its
     * lazy boundary — trips this immediately.
     *
     * TWO chunks exceed it on purpose, and always will:
     *
     *   CallRoom  ~571 kB  livekit-client, behind features/CallRoomLazy
     *   exceljs   ~940 kB  behind the Export Tasks dynamic import
     *
     * Both are loaded on demand and are not on anyone's critical path, so
     * their size is a cost we have chosen rather than a defect.
     *
     * That makes the warning countable rather than noisy: two entries in that
     * list is the expected state, and a THIRD is the signal. Rollup cannot
     * distinguish an eager chunk from a lazy one, so this is the closest thing
     * to a meaningful budget the tool offers — and it is worth having, because
     * the 1.45 MB entry chunk that prompted all of this never tripped the
     * default in a way anybody acted on.
     */
    chunkSizeWarningLimit: 350,
  },
}));
