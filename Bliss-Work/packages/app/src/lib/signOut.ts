import type { ApiClient } from "@taskboard/shared";
import type { PlatformConfig } from "../platform";
import { useSession } from "../store/session";
import { broadcastLogout } from "./authChannel";
import { endTelemetrySession } from "./telemetry";

/**
 * Sign out, in the order that actually makes the person go offline.
 *
 * Signing out used to be four lines in the account menu: revoke, clear the
 * store, drop the persisted refresh token, navigate. Everything else was left
 * to React unmounting the authenticated shell — and that is where "I logged out
 * and I still show as Online" came from, twice over:
 *
 *   1. The ACTIVITY SESSION (telemetry-svc) is closed by a final beacon. The
 *      shell's cleanup does send one, but it runs AFTER the session store has
 *      been cleared, so it carries no bearer token, 401s, and closes nothing.
 *      The session then stays open until the server's sweeper times it out, and
 *      an admin's Members list reads the person as Online for the whole of it.
 *   2. The SOCKET is what the gateway counts as presence. On web, unmounting
 *      does close it — eventually, and only because a cleanup happens to. On
 *      DESKTOP it does not close at all: that socket lives in a utilityProcess
 *      that deliberately outlives the window, so the person stayed online to
 *      their whole organisation with the app signed out in front of them.
 *
 * So both are done HERE, explicitly, before the token is thrown away. Neither
 * is allowed to fail the sign-out: a user who pressed the button gets signed
 * out even if the network is gone. The server-side sweeper and the socket's own
 * timeout remain the backstop for that case — slower, but never wrong.
 *
 * Navigation is the caller's, because it belongs to the router, not here.
 */
export async function signOut(
  api: ApiClient,
  config: PlatformConfig,
  /** The web build's own socket. Absent on hosts where `config.eventSource`
   *  owns the connection instead. */
  ws?: { close: () => void },
): Promise<void> {
  // 1. Say goodbye while we can still prove who we are.
  await endTelemetrySession();

  // 2. Hang up. `disconnect` is the desktop host dropping the utilityProcess
  //    socket; `ws.close()` is the web build closing its own.
  try {
    if (config.eventSource) config.eventSource.disconnect?.();
    else ws?.close();
  } catch {
    /* a failed hang-up must not strand the user in a signed-in-looking UI */
  }

  // 3. Revoke server-side, then forget everything local. `getRefreshToken` is
  //    the same accessor refreshSession() uses for the body-token fallback
  //    (see lib/refresh.ts) — desktop/mobile's refresh cookie doesn't
  //    reliably travel, so without this /auth/logout had no credential at
  //    all on those platforms and only ever cleared a cookie that was never
  //    really the source of truth there.
  const bodyToken = await config.getRefreshToken?.().catch(() => null);
  await api.logout(bodyToken ?? undefined).catch(() => {});
  useSession.getState().clear();
  // Electron mirrors the refresh token to an encrypted file so the session
  // survives a restart; without this, signing out would leave that mirror on
  // disk and the next launch would silently restore the session.
  config.persistRefreshToken?.(null);
  broadcastLogout(); // sign out sibling tabs too
}
