import { SessionDTO } from "@taskboard/shared"; // value import: it's a Zod schema
import { useSession } from "../store/session";
import { broadcastSession, getRecentSession } from "./authChannel";

/**
 * Session refresh, deduped at THREE levels so a rotating refresh token is never
 * presented twice concurrently (reuse ⇒ the backend revokes the family ⇒ logout):
 *
 *   1. Per-tab single-flight (`inFlight`) — one network call per burst within a
 *      tab (StrictMode double-invoke, a WS re-auth racing the bootstrap, …).
 *   2. Cross-tab serialization via the Web Locks API — two TABS sharing the one
 *      refresh cookie are queued so they never refresh the same cookie value at
 *      once. The lock is held for the whole network round-trip, so by the time
 *      the next tab runs, the browser cookie store already holds the rotated
 *      token and that tab refreshes cleanly (or short-circuits, see #3).
 *   3. Cross-tab short-circuit — if a sibling tab broadcast a fresh session in
 *      the last few seconds (the concurrent-bootstrap case), adopt it instead of
 *      rotating the token again.
 *
 * Where Web Locks is unavailable (old Safari, non-secure context) it degrades to
 * just #1 + #3 — correctness for the common single-tab case is unaffected.
 */
let inFlight: Promise<SessionDTO | null> | null = null;

/**
 * Set once the server says this session is over for good ('reused' — the token
 * family was revoked — or 'expired'). Two jobs:
 *
 *   1. Stop the loop. Every 401'd request retries once through refreshSession
 *      (ApiClient.req), and the presence poll fires every 20s on three screens,
 *      so a revoked family produced an endless drip of identical 401s: 26 in
 *      eight minutes in the incident that prompted this. Once dead, refresh
 *      answers null locally and touches the network no more.
 *   2. Tell the user. The app used to keep looking signed in while every request
 *      failed underneath it, because a failed refresh is USUALLY transient and
 *      is deliberately not destructive. A revoked family is not transient.
 */
let sessionDead = false;

/** Terminal codes from auth-svc's /auth/refresh (see service.py RefreshError).
 *  Anything else — a network blip, a missing cookie, a 5xx — stays
 *  non-destructive. 'deactivated' means an admin suspended or removed this
 *  membership: the session must end at the next refresh rather than linger
 *  until the ~15-minute access token expires. */
const TERMINAL_CODES = new Set(["reused", "expired", "deactivated"]);

/** True once refresh has failed terminally; cleared by a successful login. */
export function isSessionDead(): boolean {
  return sessionDead;
}

// Any successful sign-in mints a NEW token family, so the breaker must open
// again. Subscribing here covers every entry point at once — login, onboarding,
// invite-accept, org switch — instead of relying on each one to remember.
useSession.subscribe((s) => {
  if (s.status === "authed") sessionDead = false;
});

async function performRefresh(
  authBase: string,
  persist?: (token: string | null) => void,
  getRefreshToken?: () => Promise<string | null>,
): Promise<SessionDTO | null> {
  // #3: a sibling tab just refreshed and broadcast its session while we were
  // queued on the lock — adopt it rather than rotating the cookie a second time.
  const recent = getRecentSession();
  if (recent) {
    useSession
      .getState()
      .setSession({ user: recent.user, accessToken: recent.accessToken });
    return recent;
  }

  try {
    // Electron only: the packaged renderer is on file://, so the SameSite=lax
    // refresh cookie is never attached to this cross-site request and the server
    // would 401 with "missing refresh token". /auth/refresh also reads the token
    // from the body, so the host hands it over explicitly. On web this is
    // undefined and the request is byte-for-byte what it always was — the cookie
    // stays HttpOnly and keeps its SameSite protection.
    const bodyToken = getRefreshToken ? await getRefreshToken().catch(() => null) : null;
    const res = await fetch(`${authBase}/auth/refresh`, {
      method: "POST",
      // Kept unconditional: web depends on it, and on desktop it is a harmless
      // no-op (the cookie exists in the jar, it just won't travel cross-site).
      credentials: "include",
      ...(bodyToken
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: bodyToken }),
          }
        : {}),
    });
    // Return null on failure WITHOUT clearing the in-memory session. A failed
    // refresh is often transient — a rotating-refresh-token race, a reload firing
    // mid-refresh, or a brief network blip — and the current access token is
    // usually still valid. Nuking the session here turned every such blip into a
    // full logout + WS teardown + reconnect storm. The authoritative logout
    // decision lives at the call sites that know the context: SessionBootstrap
    // clears on a null result at page load (no token yet ⇒ go to /login), while
    // mid-session callers (the API 401-retry, the WS re-auth) just let the one
    // request fail and keep the session so the user isn't bounced on a hiccup.
    if (!res.ok) {
      // A 401 that names a terminal reason means the refresh family is gone:
      // no amount of retrying brings it back, and every later request will 401.
      // Clear the session so the router sends the user to /login instead of
      // leaving a signed-in-looking UI on top of a dead session.
      if (res.status === 401) {
        const code = await res
          .json()
          .then((b: { code?: string }) => b?.code)
          .catch(() => undefined);
        if (code && TERMINAL_CODES.has(code)) {
          sessionDead = true;
          persist?.(null);
          useSession.getState().clear();
        }
      }
      return null;
    }
    // Validate the session payload at the trust boundary rather than trusting a
    // bare cast — a malformed body fails the refresh cleanly (→ login) instead of
    // writing corrupt user/token state into the session store.
    const parsed = SessionDTO.safeParse(await res.json());
    if (!parsed.success) return null;
    const s = parsed.data;
    useSession.getState().setSession({ user: s.user, accessToken: s.accessToken });
    persist?.(s.accessToken);
    // Tell sibling tabs so they adopt this session instead of rotating again.
    broadcastSession(s);
    return s;
  } catch {
    return null;
  }
}

export function refreshSession(
  authBase: string,
  persist?: (token: string | null) => void,
  getRefreshToken?: () => Promise<string | null>,
): Promise<SessionDTO | null> {
  // Circuit breaker: the family is revoked, so asking again can only produce
  // another 401. Answer locally until the user signs in again.
  if (sessionDead) return Promise.resolve(null);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const locks = (
        globalThis as unknown as {
          navigator?: {
            locks?: { request: <T>(name: string, cb: () => Promise<T>) => Promise<T> };
          };
        }
      ).navigator?.locks;
      if (locks?.request) {
        // Exclusive lock across all same-origin tabs; held for the whole refresh.
        return await locks.request("tb-auth-refresh", () =>
          performRefresh(authBase, persist, getRefreshToken),
        );
      }
      return await performRefresh(authBase, persist, getRefreshToken);
    } finally {
      // Release the in-flight slot the moment this refresh settles so the next
      // refresh (the following token expiry) starts fresh. Concurrent callers
      // during the request already share THIS promise via the guard above.
      inFlight = null;
    }
  })();
  return inFlight;
}
