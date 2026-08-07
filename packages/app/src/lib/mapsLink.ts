/**
 * "Open in Maps" links for a shared location.
 *
 * This is the part of location sharing that ALWAYS works: no API key, no
 * network call, no third-party script. The static map thumbnail is an
 * enhancement layered on top; if it never loads, the user can still open the
 * coordinates in their own maps app.
 *
 * The URLs are plain https with no credentials, which is what lets them pass
 * the desktop app's `safeExternalUrl` allowlist and hand off to the system
 * browser via `shell.openExternal`.
 */

function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  // `platform` is deprecated but still the most reliable signal available in
  // Electron; userAgent is the fallback.
  const hay = `${(navigator as { platform?: string }).platform ?? ""} ${navigator.userAgent}`;
  return /Mac|iPhone|iPad|iPod/i.test(hay);
}

/** A maps URL for the viewer's platform. */
export function mapsLink(lat: number, lng: number, label?: string): string {
  const coords = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  if (isApplePlatform()) {
    const q = label ? `&q=${encodeURIComponent(label)}` : "";
    return `https://maps.apple.com/?ll=${coords}${q}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${coords}`;
}

/** Human-readable coordinates for the bubble's caption. */
export function formatCoords(lat: number, lng: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(5)}° ${ns}, ${Math.abs(lng).toFixed(5)}° ${ew}`;
}
