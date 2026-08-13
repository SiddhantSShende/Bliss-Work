import { app, safeStorage, session } from "electron";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveEndpoints } from "../shared/endpoints";
import { refreshTokenFromSetCookie } from "../shared/refresh-cookie";

/**
 * The desktop refresh token, kept where the renderer can actually reach it.
 *
 * WHY THIS FILE EXISTS. auth-svc issues the refresh token as an HttpOnly cookie
 * with SameSite=lax (services/auth-svc/app/routes/cookies.py). A packaged build
 * loads the renderer from file:// (see windows.ts), so every request it makes to
 * https://communication.rnrtechs.com is CROSS-SITE, and Chromium will not attach
 * a Lax cookie to a cross-site fetch. The cookie is stored fine — it just never
 * goes back out. The symptom is nasty because it isn't a crash: the bootstrap
 * refresh 401s with "missing refresh token", so every launch lands on /login,
 * and ~15 minutes after login (JWT_ACCESS_TTL_SECONDS=900) the access token ages
 * out, refresh keeps failing, and the app half-dies — refresh.ts deliberately
 * does NOT clear the session on a failed refresh, so the UI stays put while
 * every action quietly fails. Dev never sees it: there the renderer is
 * http://localhost:5174 and auth-svc is localhost, which is same-site.
 *
 * THE FIX. /auth/refresh already accepts the token in the request BODY as well
 * as the cookie (`raw = (body.token if body else None) or refresh_token`), so
 * the desktop sends it explicitly instead of relying on ambient cookie auth.
 * Nothing changes for web, which keeps the cookie and its SameSite protection.
 *
 * We deliberately do NOT flip COOKIE_SAMESITE to "none". That cookie is set by
 * login, refresh, logout, org-switch and invite-accept alike, so it would drop
 * the CSRF backstop for every browser user at once — and origin.py intentionally
 * allows `Origin: null`, which is what a sandboxed attacker iframe sends. Lax is
 * the only thing currently stopping a forged /auth/refresh from rotating a
 * victim's token and tripping reuse-detection into a full logout.
 *
 * ── Where the token actually comes from ─────────────────────────────────────
 * Two sources, MIRROR FIRST:
 *   1. userData/session.bin — a safeStorage-encrypted mirror, written by
 *      watchRefreshCookie() from the Set-Cookie header of every auth response.
 *   2. The Electron cookie jar — the fallback, for a mirror that is missing
 *      (first run after upgrade, or a box where safeStorage failed). Whatever
 *      the jar holds is copied into the mirror on the way past.
 *
 * The order used to be the other way round, on the assumption that "the cookie
 * is stored fine, it just never goes back out". That assumption is what made
 * reloading the desktop app log people out. A `SameSite=Lax` cookie is not only
 * withheld on a cross-site REQUEST — Chromium also declines to STORE it from a
 * cross-site RESPONSE, and a packaged renderer on file:// makes every call to
 * the API cross-site. So the rotated token from /auth/refresh could silently
 * fail to land in the jar, leaving the jar (and the mirror copied from it)
 * holding a token that had already been spent. Presenting a spent token trips
 * the server's reuse detection, which revokes the whole family and answers
 * `code: "reused"` — a TERMINAL code, so the client clears the session and the
 * user is at /login. Every reload, for a reason no log made obvious.
 *
 * watchRefreshCookie reads the header directly out of the network response, so
 * it is unaffected by whether Chromium chose to persist the cookie.
 *
 * Kept out of cache.ts on purpose: that file caches sticky task content and has
 * a different threat model. A credential does not belong in it.
 */

const COOKIE_NAME = "refresh_token";

let file = "";

/** Origin the refresh cookie is scoped to. Derived from the SAME endpoint
 *  resolution the renderer and ws-process use, so it can never drift from the
 *  host we actually authenticate against. */
function cookieUrl(): string {
  const { authBase } = resolveEndpoints(app.isPackaged, {
    authBase: process.env.TB_AUTH_BASE,
  });
  try {
    return new URL(authBase).origin;
  } catch {
    return authBase;
  }
}

export function initSessionToken(): void {
  file = join(app.getPath("userData"), "session.bin");
  watchRefreshCookie();
}

/**
 * Mirror the refresh token out of every auth response's Set-Cookie header.
 *
 * This is the desktop's authoritative capture point — see the file header for
 * why the cookie jar cannot be trusted to hold the rotated token. It covers
 * every path that mints one (login, refresh rotation, org switch, invite
 * accept) without any of them having to remember to, and logout's
 * `refresh_token=; Max-Age=0` clears the mirror through the same route.
 *
 * Registered once, from initSessionToken. onHeadersReceived allows a single
 * listener per session — adding another anywhere would silently replace this.
 */
function watchRefreshCookie(): void {
  const origin = cookieUrl();
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      // Header casing is not normalised across platforms, so match on the
      // lowercased key rather than indexing "set-cookie" directly.
      const headers = details.responseHeaders ?? {};
      const key = Object.keys(headers).find((k) => k.toLowerCase() === "set-cookie");
      // undefined = this response said nothing about the token, so leave the
      // mirror alone; null = the logout cookie, so clear it.
      const next = refreshTokenFromSetCookie(key ? headers[key] : undefined);
      if (next !== undefined) writeMirror(next);
      // Pass the response through untouched.
      callback({});
    },
  );
}

function readMirror(): string | null {
  if (!file || !existsSync(file)) return null;
  try {
    const raw = readFileSync(file);
    // Written encrypted whenever the OS offers a backend; plaintext only where
    // it doesn't (some bare Linux boxes with no libsecret). Try both.
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(raw);
      } catch {
        return raw.toString("utf8");
      }
    }
    return raw.toString("utf8");
  } catch {
    return null;
  }
}

function writeMirror(token: string | null): void {
  if (!file) return;
  try {
    if (token === null) {
      if (existsSync(file)) unlinkSync(file);
      return;
    }
    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(file, safeStorage.encryptString(token), { mode: 0o600 });
    } else {
      writeFileSync(file, token, { mode: 0o600 });
    }
  } catch {
    /* best-effort: a missing mirror only costs one extra login */
  }
}

/**
 * Current refresh token, MIRROR FIRST.
 *
 * The mirror is written straight from the Set-Cookie header of every auth
 * response (watchRefreshCookie), so it always holds the most recently minted
 * token. The jar can lag it — Chromium may decline to store a SameSite=Lax
 * cookie arriving on a cross-site response, which is every response in a
 * packaged file:// build — and handing back a lagging token means handing back
 * a SPENT one, which reuse-detection treats as theft and answers by revoking
 * the family. Reading the jar first is what made every reload a logout.
 *
 * The jar remains the fallback for a missing mirror (first run after an
 * upgrade, or a Linux box where safeStorage has no backend), and whatever it
 * holds is copied forward so the next read is served from the mirror.
 */
export async function getRefreshToken(): Promise<string | null> {
  const mirrored = readMirror();
  if (mirrored) return mirrored;
  try {
    const jar = await session.defaultSession.cookies.get({
      url: cookieUrl(),
      name: COOKIE_NAME,
    });
    const value = jar[0]?.value;
    if (value) {
      writeMirror(value);
      return value;
    }
  } catch {
    /* no jar entry either — the caller treats null as "please sign in" */
  }
  return null;
}

export function setRefreshToken(token: string | null): void {
  writeMirror(token);
}

/** Logout: drop both copies. Without this a logged-out app could resurrect the
 *  session from the mirror on next launch. */
export async function clearRefreshToken(): Promise<void> {
  writeMirror(null);
  try {
    await session.defaultSession.cookies.remove(cookieUrl(), COOKIE_NAME);
  } catch {
    /* best-effort */
  }
}
