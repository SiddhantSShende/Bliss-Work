import React from "react";
import { createRoot } from "react-dom/client";
import { App, type PlatformConfig } from "@taskboard/app";
import "@taskboard/ui/styles.css";
import "./index.css";

// Self-heal: drop any stale Service Worker / cache that a previous project on
// this localhost port may have registered (they survive hard-refresh and would
// otherwise keep serving an old bundle).
if ("serviceWorker" in navigator)
  navigator.serviceWorker
    .getRegistrations()
    .then((rs) => rs.forEach((r) => r.unregister()))
    .catch(() => {});
if (typeof caches !== "undefined")
  caches
    .keys()
    .then((ks) => ks.forEach((k) => caches.delete(k)))
    .catch(() => {});

// Self-heal stale lazy chunks after a deploy. If the browser had the app open
// (or a cached index.html) referencing an OLD hashed chunk that a new deploy
// removed, a dynamic import() 404s — e.g. the lazily-loaded xlsx export. Vite
// raises `vite:preloadError`; reload ONCE to fetch the fresh index.html + chunk
// hashes. A short sessionStorage guard prevents a reload loop when the chunk is
// genuinely unreachable (offline) rather than merely rotated.
window.addEventListener("vite:preloadError", (event) => {
  const now = Date.now();
  const last = Number(sessionStorage.getItem("tb:chunk-reload") ?? 0);
  if (now - last < 10_000) return; // just reloaded — don't loop
  sessionStorage.setItem("tb:chunk-reload", String(now));
  event.preventDefault(); // suppress the unhandled error; we're recovering
  window.location.reload();
});

const env = import.meta.env;

// In a PRODUCTION build the service URLs MUST be supplied at build time — the
// localhost fallbacks below are dev-only. Silently shipping a prod bundle that
// points at localhost is a broken deploy that looks fine until first request, so
// fail fast with an actionable error instead.
const REQUIRED_ENV = [
  "VITE_AUTH_BASE",
  "VITE_TASK_BASE",
  "VITE_NOTIFICATION_BASE",
  "VITE_MESSAGING_BASE",
  "VITE_INTEGRATIONS_BASE",
  "VITE_WS_URL",
] as const;
if (env.PROD) {
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required build-time env vars: ${missing.join(", ")}. ` +
        "Set them before `npm run build` so the app targets your services, not localhost.",
    );
  }
}

const config: PlatformConfig = {
  kind: "web",
  authBase: env.VITE_AUTH_BASE ?? "http://localhost:8001",
  taskBase: env.VITE_TASK_BASE ?? "http://localhost:8002",
  notificationBase: env.VITE_NOTIFICATION_BASE ?? "http://localhost:8003",
  messagingBase: env.VITE_MESSAGING_BASE ?? "http://localhost:8004",
  integrationsBase: env.VITE_INTEGRATIONS_BASE ?? "http://localhost:8005",
  wsUrl: env.VITE_WS_URL ?? "ws://localhost:8090/ws",
  router: "browser",
};

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App config={config} />
  </React.StrictMode>,
);
