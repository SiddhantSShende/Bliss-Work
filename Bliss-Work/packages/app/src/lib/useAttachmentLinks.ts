import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRuntime } from "./runtime";

/**
 * Resolves attachment ids to signed download URLs.
 *
 * A browser cannot put an Authorization header on `<img src>` or `<video src>`,
 * so the URL itself carries the authorization: a short-lived HMAC token binding
 * the attachment, org, user and expiry. The server still re-checks scope
 * membership on every hit, so a link stops working the moment the viewer loses
 * access — it is not a bearer capability that outlives their membership.
 *
 * Links are minted in ONE batched request per rendered page rather than per
 * image, and refreshed ahead of expiry so a long-lived thread view never starts
 * serving 403s into broken images.
 */

/** Server TTL is 600s (MEDIA_URL_TTL_SECONDS); refresh with room to spare. */
const REFRESH_MS = 8 * 60_000;

export function useAttachmentLinks(ids: string[]) {
  const { api } = useRuntime();
  // Sort so a re-render that reorders the same ids reuses the cache entry
  // instead of minting a fresh batch.
  const key = useMemo(() => [...new Set(ids)].sort(), [ids]);

  const query = useQuery({
    queryKey: ["attachmentLinks", key.join(",")],
    enabled: key.length > 0,
    queryFn: () => api.attachmentLinks(key),
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    // Nothing here is worth a retry storm: a missing link degrades to a
    // placeholder, and the interval will try again shortly.
    retry: 1,
  });

  // Memoized so the identity is stable between renders: callers wrap their
  // renderBody in useCallback against this object, and a fresh one every render
  // would re-render the whole message list on every keystroke in the composer.
  return useMemo(() => {
    const byId = new Map<string, string>();
    for (const l of query.data ?? []) byId.set(l.id, api.mediaUrl(l.url));
    return {
      /** Absolute signed URL, or undefined while loading or if access was denied. */
      urlFor: (id: string | undefined) => (id ? byId.get(id) : undefined),
      isLoading: query.isLoading && key.length > 0,
      /**
       * True once a mint has completed. Until then "no URL" means "still
       * loading"; afterwards it means "you may not read this file" — the two
       * need different placeholders.
       */
      isResolved: query.isSuccess || key.length === 0,
    };
  }, [query.data, query.isLoading, query.isSuccess, key.length, api]);
}
