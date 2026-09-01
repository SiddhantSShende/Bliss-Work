/**
 * Build the `taskboard://` deep link a meeting's https join page hands off
 * to. Parsed on the desktop side by apps/desktop/src/shared/deeplink.ts
 * (host `join`, param `t` — deliberately mirroring the web route `/join?t=`
 * 1:1, and kept disjoint from the unrelated `invite` deep-link's `token`
 * param).
 */
export function meetingDeepLink(token: string): string {
  return `taskboard://join?t=${encodeURIComponent(token)}`;
}

/**
 * Build a meeting's shareable `https://.../join?t=` link — the one this
 * deep link above hands off to. `webBaseUrl` must be `config.webBaseUrl`
 * (PlatformConfig), never `window.location.origin`: on the packaged
 * Electron renderer, which loads from `file://`, that would produce an
 * unopenable `file:///join?t=` link instead of a real, publicly reachable
 * URL.
 */
export function meetingJoinUrl(webBaseUrl: string, token: string): string {
  return `${webBaseUrl}/join?t=${encodeURIComponent(token)}`;
}
