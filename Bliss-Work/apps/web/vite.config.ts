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
  "VITE_INTEGRATIONS_BASE",
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
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), requireServiceUrls(mode)],
  server: {
    port: 5173,
    strictPort: true,
  },
  define: {
    __WS_URL__: JSON.stringify(process.env.VITE_WS_URL ?? "ws://localhost:8080/ws"),
  },
}));
