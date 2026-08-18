/**
 * Where the OS keeps the switch that lets a desktop app read your location.
 *
 * The app grants `geolocation` itself (main/index.ts) and so never shows a
 * Chromium prompt, which means a PERMISSION_DENIED from `getCurrentPosition` is
 * always the OS refusing rather than the user declining. On two of the three
 * platforms that refusal is a single toggle the user owns — but nothing in the
 * product could point at it, so "share location" degraded to a coarse IP fix
 * with no way back to a precise one.
 *
 * Windows is the case that makes this worth having. A Win32 app CANNOT trigger
 * a location prompt — there is no API for it — so a user whose "Let desktop apps
 * access your location" is off has no in-app path to discovering that, and no
 * prompt is ever coming. A deep link to the exact settings page is the closest
 * thing to asking that the platform permits.
 *
 * Linux is absent on purpose, not by omission: there is no OS location provider
 * to authorize, so there is no page to open and the capability is simply not
 * offered (see preload/index.ts, which omits the bridge method entirely — the
 * renderer then renders no button rather than a button that does nothing).
 *
 * Dependency-free (no electron import) for the same two reasons external-url.ts
 * is: it is unit-testable, and BOTH bundles need it — main to open the page,
 * preload to decide whether to expose the capability at all.
 */

/**
 * The per-platform settings deep link.
 *
 * These are hard-coded constants, and that is load-bearing. `external-url.ts`
 * restricts everything renderer-reachable to `https:` precisely because Windows
 * `ms-*` schemes have carried RCE chains, and `ms-settings:` is one of that
 * family. Nothing here is renderer-controlled: the caller picks a platform, the
 * platform picks a fixed string, and no argument crosses the IPC boundary. That
 * is the same reasoning under which menu.ts opens its hard-coded https link
 * directly. Do NOT widen this into "open whatever URL the renderer asks for".
 */
const SETTINGS_URLS: Partial<Record<NodeJS.Platform, string>> = {
  win32: "ms-settings:privacy-location",
  darwin:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices",
};

/**
 * The OS location-privacy page for `platform`, or null where there is none.
 *
 * Null is a meaningful answer — "this platform has no location permission to
 * grant" — and callers are expected to drop the affordance rather than show a
 * button that cannot do anything.
 */
export function locationSettingsUrl(
  platform: NodeJS.Platform = process.platform,
): string | null {
  return SETTINGS_URLS[platform] ?? null;
}

/** Whether this platform has a location-privacy page worth offering. */
export function hasLocationSettingsPage(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return locationSettingsUrl(platform) !== null;
}
