import CookieManager from '@react-native-cookies/cookies';
import {
  clearStoredRefreshToken,
  getStoredRefreshToken,
  setStoredRefreshToken,
} from './secureStore';

/**
 * The mobile refresh token, kept where the app can actually reach it.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * auth-svc issues the refresh token as an HttpOnly cookie (services/
 * auth-svc/app/routes/cookies.py) — by design, the JSON login/refresh
 * response never contains it. `HttpOnly` blocks DOM/JS access
 * (`document.cookie`), not a platform's own native cookie-store APIs, which
 * is what makes reading it back at all possible here.
 *
 * apps/desktop solved the identical problem (session-token.ts) by having
 * Electron's privileged main process intercept the raw Set-Cookie response
 * header directly (`webRequest.onHeadersReceived`) — React Native has no
 * such API. Fetch's spec explicitly forbids JS from ever reading a
 * `Set-Cookie` response header, on every platform, browser or not. So this
 * takes the other half of the SAME two-source strategy desktop uses
 * (mirror-to-secure-storage, jar as fallback), adapted to what's actually
 * available: instead of intercepting the header, it reads the NATIVE cookie
 * store (`@react-native-cookies/cookies`, which wraps iOS
 * `NSHTTPCookieStorage` / Android `CookieManager` — both can see HttpOnly
 * cookies) right after a call that mints or rotates the token, and mirrors
 * whatever it finds into the Keychain (secureStore.ts) — the same
 * "mirror-first" reasoning desktop's file header explains: reads are served
 * from the mirror, not the jar, so a value already spent/rotated server-side
 * is never handed back as if it were current.
 *
 * `/auth/refresh` accepts the token in the request BODY as well as the
 * cookie (RefreshRequest.token) — already built for exactly this, no
 * backend change needed; `packages/app/src/lib/refresh.ts` already calls
 * `config.getRefreshToken()` to populate that body field. `/auth/logout`,
 * however, reads ONLY the cookie (no body-token path) — see signOut()
 * below for how that's worked around without a backend change.
 */

const COOKIE_NAME = 'refresh_token';

/** Origin the refresh cookie is scoped to — the SAME `authBase` origin the
 *  ApiClient itself talks to, so this can never drift onto the wrong host. */
let cookieOrigin = '';

export function initAuthCookie(authBase: string): void {
  try {
    cookieOrigin = new URL(authBase).origin;
  } catch {
    cookieOrigin = authBase;
  }
}

/** Read whatever the native cookie jar currently holds for this origin,
 *  without touching the Keychain mirror. Used right after a call that mints
 *  or rotates the token (login, MFA verify, refresh, org switch). */
async function readFromJar(): Promise<string | null> {
  if (!cookieOrigin) return null;
  try {
    const cookies = await CookieManager.get(cookieOrigin);
    return cookies[COOKIE_NAME]?.value ?? null;
  } catch {
    return null;
  }
}

/** Call after any request that could have set/rotated the refresh cookie.
 *  Mirrors the fresh value into the Keychain if the jar actually has one —
 *  a response that didn't touch the cookie (most authed requests) leaves
 *  the existing mirror alone rather than erasing it. */
export async function syncRefreshTokenFromJar(): Promise<void> {
  const value = await readFromJar();
  if (value) await setStoredRefreshToken(value);
}

/** `PlatformConfig.getRefreshToken` — mirror first, jar as the fallback for
 *  a mirror that's missing (first launch after an app reinstall wiped
 *  Keychain but somehow not the jar, or a write that failed). */
export async function getRefreshToken(): Promise<string | null> {
  const mirrored = await getStoredRefreshToken();
  if (mirrored) return mirrored;
  const fromJar = await readFromJar();
  if (fromJar) await setStoredRefreshToken(fromJar);
  return fromJar;
}

/** `PlatformConfig.persistRefreshToken` — called by lib/refresh.ts whenever
 *  it already has the value in hand (unused here since RN can't read the
 *  header directly; kept as a no-op passthrough purely so this config
 *  satisfies the same shape desktop's does, and to no-op cleanly if a
 *  future backend change ever DID put the token in the response body). */
export async function persistRefreshToken(token: string | null): Promise<void> {
  if (token) {
    await setStoredRefreshToken(token);
  } else {
    await clearStoredRefreshToken();
  }
}

/**
 * Sign-out workaround for the one backend gap this can't fix: `POST
 * /auth/logout` reads the refresh token ONLY from the request's `Cookie`
 * header (services/auth-svc/app/routes/auth.py — no RefreshRequest-style
 * body param like /auth/refresh has). If the native jar's cookie has gone
 * stale relative to the Keychain mirror for any reason, the server-side
 * revoke would silently no-op. Guarantee correctness instead of hoping the
 * jar agrees: write the mirrored value into the jar immediately before the
 * logout call, so the `Cookie:` header fetch sends is provably the same
 * token being revoked.
 */
export async function ensureJarMatchesMirrorForLogout(): Promise<void> {
  if (!cookieOrigin) return;
  const token = await getStoredRefreshToken();
  if (!token) return;
  try {
    await CookieManager.set(cookieOrigin, {
      name: COOKIE_NAME,
      value: token,
      path: '/',
    });
  } catch {
    /* best-effort — logout still proceeds and clears the LOCAL session
       either way; see clearRefreshTokenEverywhere. */
  }
}

/** Full sign-out cleanup: both copies, so a signed-out app can never
 *  resurrect the session from a leftover mirror or jar entry on next
 *  launch. */
export async function clearRefreshTokenEverywhere(): Promise<void> {
  await clearStoredRefreshToken();
  if (!cookieOrigin) return;
  try {
    await CookieManager.clearByName(cookieOrigin, COOKIE_NAME);
  } catch {
    /* best-effort */
  }
}
