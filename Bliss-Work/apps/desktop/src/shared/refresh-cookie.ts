/**
 * Parsing for the refresh-token cookie the desktop shell mirrors to disk.
 *
 * Lives in shared/ (no Electron imports) so it can be unit-tested like the
 * deep-link and external-URL helpers beside it. The main process uses it from
 * a webRequest hook — see main/session-token.ts for why the cookie jar cannot
 * be trusted to hold the current token in a packaged file:// build.
 */

const COOKIE_NAME = "refresh_token";

/**
 * What one Set-Cookie line says about the refresh token:
 *   a token   → the value, to mirror
 *   ""        → the logout cookie (Max-Age=0 / Expires in the past); clear it
 *   null      → this line is about some other cookie; ignore it
 *
 * Returning "" and null as distinct answers matters: treating a clearing cookie
 * as "no information" would leave a signed-out machine holding a live token.
 */
export function parseRefreshCookie(line: string): string | null {
  // Anchor on a boundary so `xrefresh_token=` or `my_refresh_token=` can't
  // masquerade as ours.
  const m = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`, "i").exec(line);
  if (!m) return null;
  const raw = m[1] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed percent-escape is not a reason to drop the value on the
    // floor; the server round-trips it verbatim either way.
    return raw;
  }
}

/**
 * The token state implied by a whole Set-Cookie header (several lines).
 *
 * `undefined` = the header said nothing about the refresh token, so leave what
 * is on disk alone. `null` = clear it. A string = store it. The LAST line that
 * mentions the cookie wins, matching how a browser applies them in order.
 */
export function refreshTokenFromSetCookie(
  lines: readonly string[] | undefined,
): string | null | undefined {
  if (!lines) return undefined;
  let result: string | null | undefined;
  for (const line of lines) {
    const value = parseRefreshCookie(line);
    if (value === null) continue;
    result = value === "" ? null : value;
  }
  return result;
}
