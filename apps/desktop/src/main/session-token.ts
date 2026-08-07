import { app, safeStorage, session } from "electron";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveEndpoints } from "../shared/endpoints";

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
 * Two sources, in order:
 *   1. The Electron cookie jar — authoritative and self-updating, since every
 *      refresh response still carries a Set-Cookie that Chromium stores happily.
 *   2. userData/session.bin — a safeStorage-encrypted mirror, so the session
 *      survives a cleared jar. Refreshed from (1) on every read.
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
 * Current refresh token, jar first. Re-mirrors whatever the jar holds so token
 * ROTATION self-heals — each /auth/refresh rotates the token and sets a new
 * cookie, and reading it back here is what keeps session.bin from going stale
 * and presenting an already-spent token (which reuse-detection would treat as
 * theft and revoke the whole family).
 */
export async function getRefreshToken(): Promise<string | null> {
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
    /* fall through to the mirror */
  }
  return readMirror();
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
