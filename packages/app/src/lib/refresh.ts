import { SessionDTO } from "@taskboard/shared"; // value import: it's a Zod schema
import { useSession } from "../store/session";

/**
 * Single-flight session refresh. Refresh tokens ROTATE on every /auth/refresh
 * and reuse of a rotated token revokes the whole family — so two concurrent
 * refreshes (e.g. React StrictMode double-invoking the bootstrap effect, or a
 * WS re-auth racing page load) would log the user out. Sharing one in-flight
 * promise guarantees exactly one network call per burst.
 */
let inFlight: Promise<SessionDTO | null> | null = null;

export function refreshSession(
  authBase: string,
  persist?: (token: string | null) => void,
): Promise<SessionDTO | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(`${authBase}/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) return null;
      // Validate the session payload at the trust boundary rather than trusting a
      // bare cast — a malformed/unexpected body fails the refresh cleanly (→ login)
      // instead of writing corrupt user/token state into the session store.
      const parsed = SessionDTO.safeParse(await res.json());
      if (!parsed.success) return null;
      const s = parsed.data;
      useSession.getState().setSession({ user: s.user, accessToken: s.accessToken });
      persist?.(s.accessToken);
      return s;
    } catch {
      return null;
    } finally {
      // Release the in-flight slot the moment this refresh settles so the next
      // refresh (e.g. the following token expiry) starts fresh. Concurrent
      // callers during the request already share THIS promise via the
      // `if (inFlight) return inFlight` guard above, so clearing on settle can't
      // split one burst into two network calls (which would revoke the rotating
      // refresh token). Clearing synchronously here — rather than via a deferred
      // timer — closes the window where a stale resolved promise could be reused.
      inFlight = null;
    }
  })();
  return inFlight;
}
