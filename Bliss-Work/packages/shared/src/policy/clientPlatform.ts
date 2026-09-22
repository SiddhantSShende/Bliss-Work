/**
 * Which client is signing in, as the auth backend is told on /auth/login.
 *
 * Every client — web, Electron, mobile — talks to the same backend, so the
 * platform-specific CAPTCHA policy has to be decided there. The value is
 * DECLARED by the client and cannot be verified: it is a product policy input,
 * not a security control. The backend treats anything it does not recognise as
 * "CAPTCHA required".
 *
 * Keep `CAPTCHA_EXEMPT_PLATFORMS` (services/auth-svc/app/config.py) in step
 * with `isCaptchaExemptPlatform` below. If they drift, the server wins: a client
 * that skips the CAPTCHA against a server that wants it gets a 400, and the login
 * screens then fall back to showing the challenge.
 */
export const CLIENT_PLATFORMS = ["windows", "macos", "linux", "ios", "android", "unknown"] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

/** True for platforms whose sign-in is not CAPTCHA-challenged (macOS, iOS). */
export function isCaptchaExemptPlatform(platform: ClientPlatform | null | undefined): boolean {
  return platform === "macos" || platform === "ios";
}
