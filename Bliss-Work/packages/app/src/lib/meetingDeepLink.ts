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
