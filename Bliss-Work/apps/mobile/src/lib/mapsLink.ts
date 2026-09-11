import { Platform } from 'react-native';

/**
 * "Open in Maps" deep link for a shared location — same URL formats as
 * packages/app/src/lib/mapsLink.ts's `mapsLink`, but picking Apple vs Google
 * Maps via `Platform.OS` instead of sniffing `navigator.platform`/
 * `userAgent`: React Native's `navigator` carries no such signal, so the web
 * implementation would always fall through to Google Maps here even on iOS.
 */
export function mapsLink(lat: number, lng: number, label?: string): string {
  const coords = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  if (Platform.OS === 'ios') {
    const q = label ? `&q=${encodeURIComponent(label)}` : '';
    return `https://maps.apple.com/?ll=${coords}${q}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${coords}`;
}
