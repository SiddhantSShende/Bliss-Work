import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import * as Location from 'expo-location';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { encodeLocation } from '@taskboard/app/chatEnvelope';

/**
 * One-time current-location share for one conversation.
 *
 * Mirrors `onShareLocation`/`sendLocation` in packages/app/src/features/
 * useChatMedia.tsx (the web equivalent): resolve a fix, best-effort tag it
 * with a place name via `api.reverseGeocode`, then send a single location
 * message. This is a mobile-local implementation rather than a shared import
 * because the web version drives the browser's `navigator.geolocation` and a
 * desktop-only settings deep link — a phone has a real OS locator behind
 * `expo-location` instead, so the fallback path (`api.whereami`'s IP-based
 * guess) is only needed when the device itself can't get a fix, not as the
 * primary path.
 */
export function useShareLocation(sendBody: (body: string) => Promise<unknown>) {
  const { api } = useRuntime();
  const [sharing, setSharing] = useState(false);

  const shareLocation = useCallback(async () => {
    setSharing(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      let lat: number, lng: number, accuracy: number | undefined;

      if (perm.granted) {
        try {
          const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          lat = pos.coords.latitude;
          lng = pos.coords.longitude;
          accuracy = pos.coords.accuracy ?? undefined;
        } catch {
          const coarse = await api.whereami();
          if (!coarse) {
            Alert.alert("Couldn't determine your location", 'Please try again.');
            return;
          }
          ({ lat, lng, accuracy } = coarse);
        }
      } else {
        // Denied — fall back to the server's coarse, IP-based guess rather
        // than refusing outright, same as the web app does when the browser
        // has no geolocation provider to ask.
        const coarse = await api.whereami();
        if (!coarse) {
          Alert.alert(
            'Location permission needed',
            'Allow location access in your device Settings to share your precise location.',
          );
          return;
        }
        ({ lat, lng, accuracy } = coarse);
      }

      const label = (await api.reverseGeocode(lat, lng)) ?? undefined;
      await sendBody(encodeLocation({ lat, lng, accuracy, label }));
    } catch (err) {
      console.error('[chat-location] share failed', err);
      Alert.alert("Couldn't share your location", 'Please try again.');
    } finally {
      setSharing(false);
    }
  }, [api, sendBody]);

  return { shareLocation, sharing };
}
