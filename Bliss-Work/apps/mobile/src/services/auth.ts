import type { ApiClient } from '@taskboard/shared';
import { useSession } from '@taskboard/app/store/session';
import { clearRefreshTokenEverywhere, ensureJarMatchesMirrorForLogout } from './authCookie';

/**
 * Full sign-out: revoke the refresh token family server-side, then clear
 * every local trace of it, then clear the in-memory session.
 *
 * `ensureJarMatchesMirrorForLogout` runs FIRST — see its own doc comment —
 * because /auth/logout reads the refresh token only from the request
 * cookie, unlike /auth/refresh which also accepts a body token.
 */
export async function signOut(api: ApiClient): Promise<void> {
  await ensureJarMatchesMirrorForLogout();
  try {
    await api.logout();
  } catch {
    // Best-effort: a network failure here must not strand the user in a
    // signed-in-looking UI. The local session is cleared regardless below.
  }
  await clearRefreshTokenEverywhere();
  useSession.getState().clear();
}
