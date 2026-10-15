/**
 * The ApiClient config the ws-process builds from the endpoints main sends it.
 *
 * Extracted from ws-process.ts (a utilityProcess entry with import-time side
 * effects) so it can be tested. Typed against `Endpoints` — the same shape main
 * posts as `{type:"config", ...ENDPOINTS}` — so a base added to `Endpoints`
 * is visible here. `stickyBase` was once dropped on this hop: every sticky-svc
 * call (pin sync, Unpin, delivery acks) then silently took its "not configured"
 * path in the desktop's one REST client.
 */
import type { ApiClient } from "@taskboard/shared";
import type { Endpoints } from "../shared/endpoints";

type ApiConfig = ConstructorParameters<typeof ApiClient>[0];

export function buildApiConfig(
  cfg: Endpoints,
  auth: Pick<ApiConfig, "getToken" | "refreshToken" | "clientId">,
): ApiConfig {
  return {
    authBase: cfg.authBase,
    taskBase: cfg.taskBase,
    messagingBase: cfg.messagingBase,
    telemetryBase: cfg.telemetryBase,
    notificationBase: cfg.notificationBase,
    stickyBase: cfg.stickyBase,
    integrationsBase: cfg.integrationsBase,
    presenceBase: cfg.wsUrl.replace(/^ws/, "http").replace(/\/ws\/?$/, ""),
    ...auth,
  };
}
