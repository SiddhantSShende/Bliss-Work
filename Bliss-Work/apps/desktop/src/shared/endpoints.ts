/**
 * Service endpoints for the desktop app — the SINGLE definition.
 *
 * Both processes need these: the renderer builds its ApiClient/WsClient from
 * them, and the main process hands them to the ws-process utility fork. They
 * used to be declared twice, in src/main/index.ts and src/renderer/main.tsx,
 * kept in sync by nothing but a comment on each copy saying "keep in lock-step".
 * A packaged build that disagreed with itself would authenticate against one
 * host and open its socket against another.
 *
 * The two processes still differ in HOW they detect prod and read overrides —
 * main has `app.isPackaged` and `process.env`, the renderer has
 * `import.meta.env` — so each passes its own answer in rather than importing
 * anything Electron- or Vite-specific here. This module stays dependency-free
 * so both bundles can include it.
 */

export interface Endpoints {
  authBase: string;
  taskBase: string;
  notificationBase: string;
  messagingBase: string;
  telemetryBase: string;
  /** sticky-svc: the durable record of which task notes belong on this
   *  desktop. Additive — when this points at nothing reachable, the notes fall
   *  back to task-svc's /tasks/sticky exactly as before. */
  stickyBase: string;
  /** integrations-svc: connected-account OAuth (Settings > Microsoft 365). */
  integrationsBase: string;
  wsUrl: string;
}

/** A packaged build talks to the hosted BlissWork backend — the SAME origin the
 *  production web app uses — so a downloaded installer works with no config. */
const PROD_ORIGIN = "https://communication.rnrtechs.com";

export const PROD_ENDPOINTS: Endpoints = {
  authBase: `${PROD_ORIGIN}/api/auth`,
  taskBase: `${PROD_ORIGIN}/api/tasks`,
  notificationBase: `${PROD_ORIGIN}/api/notifications`,
  messagingBase: `${PROD_ORIGIN}/api/messaging`,
  telemetryBase: `${PROD_ORIGIN}/api/telemetry`,
  stickyBase: `${PROD_ORIGIN}/api/sticky`,
  integrationsBase: `${PROD_ORIGIN}/api/integrations`,
  wsUrl: "wss://communication.rnrtechs.com/ws",
};

/** Dev targets the local compose stack (see docker-compose.yml). */
export const DEV_ENDPOINTS: Endpoints = {
  authBase: "http://localhost:8001",
  taskBase: "http://localhost:8002",
  notificationBase: "http://localhost:8003",
  messagingBase: "http://localhost:8004",
  telemetryBase: "http://localhost:8006",
  stickyBase: "http://localhost:8008",
  integrationsBase: "http://localhost:8005",
  wsUrl: "ws://localhost:8090/ws",
};

/**
 * Resolve the endpoint set.
 *
 * @param isProd    packaged (main) / `!import.meta.env.DEV` (renderer)
 * @param overrides per-key overrides from TB_* (main) or VITE_* (renderer);
 *                  undefined/empty values fall through to the default.
 */
export function resolveEndpoints(
  isProd: boolean,
  overrides: Partial<Record<keyof Endpoints, string | undefined>> = {},
): Endpoints {
  const base = isProd ? PROD_ENDPOINTS : DEV_ENDPOINTS;
  const pick = (k: keyof Endpoints) => overrides[k] || base[k];
  return {
    authBase: pick("authBase"),
    taskBase: pick("taskBase"),
    notificationBase: pick("notificationBase"),
    messagingBase: pick("messagingBase"),
    telemetryBase: pick("telemetryBase"),
    stickyBase: pick("stickyBase"),
    integrationsBase: pick("integrationsBase"),
    wsUrl: pick("wsUrl"),
  };
}

/**
 * The form the two entry points MUST use.
 *
 * Identical to `resolveEndpoints` except that the overrides object is a full
 * `Record<keyof Endpoints, …>` rather than a `Partial`, so every key has to be
 * named at the call site. Omitting one is a compile error rather than a silent
 * fallback to the baked default.
 *
 * That is not hypothetical tidiness. Both entry points shipped for months
 * without `telemetryBase` in their override maps: `VITE_TELEMETRY_BASE` worked
 * on the web app and was silently ignored on the desktop, so a deployment that
 * pointed telemetry anywhere other than the default had a desktop app quietly
 * talking to the wrong host — and the whole member-activity section failing
 * only there. A `Partial` cannot tell you that; a required key can.
 *
 * `resolveEndpoints` keeps its Partial signature because tests legitimately
 * override one key at a time.
 */
export function resolveEndpointsFromEnv(
  isProd: boolean,
  overrides: Record<keyof Endpoints, string | undefined>,
): Endpoints {
  return resolveEndpoints(isProd, overrides);
}
