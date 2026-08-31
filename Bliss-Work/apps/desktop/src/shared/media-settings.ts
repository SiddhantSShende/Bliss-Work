/**
 * Where the OS keeps the switch that lets a desktop app use the camera or
 * microphone.
 *
 * The app grants `media` itself (main/index.ts) and so never shows a
 * Chromium prompt, which means a getUserMedia NotAllowedError is always the
 * OS refusing rather than the user declining. Mirrors location-settings.ts
 * exactly, for the same reason: dependency-free (no electron import) so it
 * is unit-testable and usable from both main (to open the page) and preload
 * (to decide whether to expose the capability at all).
 */

export type MediaKind = "camera" | "microphone";

/**
 * The per-platform, per-kind settings deep link.
 *
 * Hard-coded constants — see location-settings.ts's own doc comment on why
 * that is load-bearing (external-url.ts's `https:`-only rule for anything
 * renderer-reachable). No argument crosses the IPC boundary; the caller
 * picks a kind and a platform, the platform picks a fixed string.
 */
const SETTINGS_URLS: Record<MediaKind, Partial<Record<NodeJS.Platform, string>>> = {
  camera: {
    win32: "ms-settings:privacy-webcam",
    darwin: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
  },
  microphone: {
    win32: "ms-settings:privacy-microphone",
    darwin: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  },
};

/**
 * The OS camera/microphone-privacy page for `kind` on `platform`, or null
 * where there is none.
 *
 * Null is a meaningful answer — "this platform has no such permission to
 * grant" — and callers are expected to drop the affordance rather than show
 * a button that cannot do anything.
 */
export function mediaSettingsUrl(
  kind: MediaKind,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return SETTINGS_URLS[kind][platform] ?? null;
}

/** Whether this platform has a camera/microphone-privacy page worth offering. */
export function hasMediaSettingsPage(
  kind: MediaKind,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return mediaSettingsUrl(kind, platform) !== null;
}
