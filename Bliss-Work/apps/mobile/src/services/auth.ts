import type { ApiClient } from '@taskboard/shared';
import { useSession } from '@taskboard/app/store/session';
import { clearRefreshTokenEverywhere, getRefreshToken } from './authCookie';

/**
 * Full sign-out: revoke the refresh token family server-side, then clear
 * every local trace of it, then clear the in-memory session.
 *
 * `getRefreshToken()` is the same mirror-first accessor the /auth/refresh
 * body-token path uses (see AppProviders.tsx) — /auth/logout accepts that
 * same body token now, so the raw value goes straight into the request
 * instead of round-tripping through the native cookie jar first.
 */
export async function signOut(api: ApiClient): Promise<void> {
  const token = await getRefreshToken();
  try {
    await api.logout(token ?? undefined);
  } catch {
    // Best-effort: a network failure here must not strand the user in a
    // signed-in-looking UI. The local session is cleared regardless below.
  }
  await clearRefreshTokenEverywhere();
  useSession.getState().clear();
}
