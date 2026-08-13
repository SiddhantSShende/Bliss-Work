import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRuntime } from "./runtime";

/**
 * Fetches a static map thumbnail for a shared location and exposes it as an
 * object URL.
 *
 * The image comes from our own API, which proxies and caches the map provider,
 * so it is same-origin (no CSP change anywhere) and the viewer's IP never
 * reaches the provider. It is fetched rather than pointed at directly because
 * the endpoint is Bearer-authed like the rest of /api/v1 — and unlike an
 * attachment, a ~40 KB tile is fine to hold in memory.
 *
 * Resolves to null whenever no thumbnail is available (no provider key, upstream
 * down, request failed). That is a supported state: LocationBubble renders the
 * coordinates card, which is fully functional on its own.
 */
export function useStaticMap(lat: number, lng: number, zoom = 15) {
  const { api } = useRuntime();

  // Round to the same 5 decimals the server uses for its cache key, so two
  // viewers of the same pin share one query entry.
  const key = `${lat.toFixed(5)},${lng.toFixed(5)},${zoom}`;

  const { data: blob, isLoading } = useQuery({
    queryKey: ["staticMap", key],
    queryFn: () => api.staticMap(lat, lng, zoom),
    // Map tiles for fixed coordinates never change.
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    // The endpoint already answers 204 rather than failing, so a rejection here
    // means the network is down — retrying would just spin.
    retry: false,
  });

  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    // Revoke on unmount//change or every scrolled-past location leaks a blob.
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  return { url, isLoading };
}
