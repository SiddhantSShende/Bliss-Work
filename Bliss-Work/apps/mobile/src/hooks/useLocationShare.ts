import { useCallback, useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { useRuntime } from '@taskboard/app/lib/runtime';

export type LocationPhase =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'ready'; lat: number; lng: number; accuracy?: number; label?: string; approximate: boolean; mapUri?: string }
  | { kind: 'denied'; canAskAgain: boolean }
  | { kind: 'error'; message: string; canUseApproximate: boolean };

const FIX_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function blobToDataUri(blob: Blob): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const r = new FileReader();
      r.onloadend = () => resolve(typeof r.result === 'string' ? r.result : undefined);
      r.onerror = () => resolve(undefined);
      r.readAsDataURL(blob);
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Drives the "share my location" sheet: permission -> fix -> preview.
 * Mirrors packages/app's useChatMedia location flow (resolve a fix, best-effort
 * name it with `api.reverseGeocode`, best-effort thumbnail with `api.staticMap`),
 * with the mobile permission states handled explicitly:
 *   granted / denied (can ask again) / denied permanently / services off /
 *   no fix within 15 s / network failure.
 * The precise fix never falls back to a coarse IP guess silently — approximate
 * location (`api.whereami`) is only used when the user chooses it.
 */
export function useLocationShare(active: boolean) {
  const { api } = useRuntime();
  const [phase, setPhase] = useState<LocationPhase>({ kind: 'idle' });
  const run = useRef(0);

  const finish = useCallback(
    async (id: number, lat: number, lng: number, accuracy: number | undefined, approximate: boolean) => {
      const [label, blob] = await Promise.all([
        api.reverseGeocode(lat, lng).catch(() => null),
        api.staticMap(lat, lng).catch(() => null),
      ]);
      const mapUri = blob ? await blobToDataUri(blob) : undefined;
      if (run.current !== id) return;
      setPhase({ kind: 'ready', lat, lng, accuracy, label: label ?? undefined, approximate, mapUri });
    },
    [api],
  );

  const locate = useCallback(async () => {
    const id = ++run.current;
    setPhase({ kind: 'locating' });
    try {
      let perm = await Location.getForegroundPermissionsAsync();
      if (!perm.granted && perm.canAskAgain) perm = await Location.requestForegroundPermissionsAsync();
      if (run.current !== id) return;
      if (!perm.granted) {
        setPhase({ kind: 'denied', canAskAgain: perm.canAskAgain });
        return;
      }
      if (!(await Location.hasServicesEnabledAsync())) {
        setPhase({ kind: 'error', message: 'Location services are turned off on this device.', canUseApproximate: true });
        return;
      }
      let pos: Location.LocationObject | null = null;
      try {
        pos = await withTimeout(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), FIX_TIMEOUT_MS);
      } catch {
        pos = await Location.getLastKnownPositionAsync().catch(() => null);
      }
      if (run.current !== id) return;
      if (!pos) {
        setPhase({ kind: 'error', message: "Couldn't get a location fix. Check that you have GPS or network signal and try again.", canUseApproximate: true });
        return;
      }
      await finish(id, pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? undefined, false);
    } catch {
      if (run.current === id) setPhase({ kind: 'error', message: "Couldn't determine your location.", canUseApproximate: true });
    }
  }, [finish]);

  const useApproximate = useCallback(async () => {
    const id = ++run.current;
    setPhase({ kind: 'locating' });
    try {
      const coarse = await api.whereami();
      if (run.current !== id) return;
      if (!coarse) {
        setPhase({ kind: 'error', message: 'Approximate location is not available either.', canUseApproximate: false });
        return;
      }
      await finish(id, coarse.lat, coarse.lng, coarse.accuracy, true);
    } catch {
      if (run.current === id) setPhase({ kind: 'error', message: 'Network problem while looking up your location.', canUseApproximate: false });
    }
  }, [api, finish]);

  // Start when the sheet opens; cancel any in-flight lookup when it closes.
  useEffect(() => {
    if (active) void locate();
    else {
      run.current++;
      setPhase({ kind: 'idle' });
    }
  }, [active, locate]);

  return { phase, retry: locate, useApproximate };
}
