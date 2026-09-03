import * as Keychain from 'react-native-keychain';

/**
 * OS Keychain (iOS) / Keystore (Android) wrapper for the one credential this
 * app persists to disk: the refresh token. Never AsyncStorage — that's
 * unencrypted plain text on both platforms, and this is exactly the
 * long-lived (30-day) credential a stolen/backed-up device would otherwise
 * hand over in the clear.
 *
 * One fixed `service` key, since there is exactly one secret to store — a
 * per-user key isn't needed because signing out (see clearRefreshToken)
 * always removes it before a different account could sign in on the same
 * device.
 */
const SERVICE = 'com.blisswork.mobile.refreshToken';
/** react-native-keychain requires a non-empty "username" even for a secret
 *  that has no meaningful one of its own. */
const PLACEHOLDER_USERNAME = 'refresh_token';

export async function getStoredRefreshToken(): Promise<string | null> {
  try {
    const result = await Keychain.getGenericPassword({ service: SERVICE });
    return result ? result.password : null;
  } catch {
    // A locked/unavailable keychain (e.g. mid-boot before the device is
    // unlocked once) is not a reason to crash — the caller treats null the
    // same as "no refresh token yet, please sign in".
    return null;
  }
}

export async function setStoredRefreshToken(token: string): Promise<void> {
  try {
    await Keychain.setGenericPassword(PLACEHOLDER_USERNAME, token, {
      service: SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch {
    // Best-effort, mirroring the desktop mirror's own write failure handling
    // (session-token.ts): a missing write costs one extra login, not a crash.
  }
}

export async function clearStoredRefreshToken(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: SERVICE });
  } catch {
    /* best-effort */
  }
}
