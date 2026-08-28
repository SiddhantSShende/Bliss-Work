import React from "react";
import { createRoot } from "react-dom/client";
import { App, installChunkReloadRecovery, type PlatformConfig } from "@taskboard/app";
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

// Stale-chunk recovery, shared with the desktop entry so both platforms
// recover identically (see packages/app/src/lib/chunkReloadRecovery.ts).
installChunkReloadRecovery();

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
  "VITE_TELEMETRY_BASE",
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
  telemetryBase: env.VITE_TELEMETRY_BASE ?? "http://localhost:8006",
  // Deliberately absent from REQUIRED_ENV: the GraphQL gateway fronts a few
  // read paths, and a build without it simply takes the REST path on those
  // screens. Making it mandatory would turn an optional optimisation into a
  // deploy blocker.
  graphBase: env.VITE_GRAPH_BASE,
  wsUrl: env.VITE_WS_URL ?? "ws://localhost:8090/ws",
  router: "browser",
  // Deliberately absent from REQUIRED_ENV, same reasoning as graphBase: no
  // stable extension id is pinned yet (see PlatformConfig's own doc comment
  // on chromeExtensionId), so a build without it just keeps today's manual
  // "paste a code" extension-connect flow instead of the automatic one.
  chromeExtensionId: env.VITE_EXTENSION_ID,
  // Same reasoning again: no store listing exists for any of these yet (see
  // extensionInstallUrls' own doc comment) — each is simply absent until this
  // deployment has somewhere real to publish the extension.
  extensionInstallUrls: {
    chrome: env.VITE_EXTENSION_INSTALL_URL_CHROME,
    edge: env.VITE_EXTENSION_INSTALL_URL_EDGE,
    brave: env.VITE_EXTENSION_INSTALL_URL_BRAVE,
    firefox: env.VITE_EXTENSION_INSTALL_URL_FIREFOX,
    safari: env.VITE_EXTENSION_INSTALL_URL_SAFARI,
  },
};

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App config={config} />
  </React.StrictMode>,
);
