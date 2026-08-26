import { useEffect, useState } from "react";

interface BlobPreview {
  /** Local `blob:` object URL for the fetched bytes; undefined while loading or on error. */
  url: string | undefined;
  isLoading: boolean;
  error: string | undefined;
}

/**
 * Fetches a signed attachment URL into memory and exposes it as a local
 * `blob:` object URL, for previewing a document (e.g. inside an `<iframe>`)
 * without navigating anywhere.
 *
 * A `blob:` URL is what the app's CSP already trusts for locally-previewed
 * content (see lib/download.ts's downloadBlob and the `img-src ... blob:`
 * directive in index.html) — unlike pointing an <iframe> straight at the
 * signed URL, which would need the remote API origin itself allowlisted in
 * frame-src on the packaged desktop build (whose renderer runs on a `file://`
 * origin, not the API's).
 *
 * The signed URL carries its own authorization in the query string (see
 * useAttachmentLinks), so a plain `fetch` needs no Authorization header —
 * same as the `<img src>`/`<video src>` it sits alongside.
 */
export function useBlobUrl(source: string | undefined): BlobPreview {
  const [state, setState] = useState<{ url?: string; error?: string }>({});

  useEffect(() => {
    setState({});
    if (!source) return;

    let objectUrl: string | undefined;
    let cancelled = false;

    fetch(source)
      .then((res) => {
        if (!res.ok) throw new Error(`Preview failed to load (${res.status})`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ error: err instanceof Error ? err.message : "Couldn't load preview" });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source]);

  return {
    url: state.url,
    isLoading: !!source && !state.url && !state.error,
    error: state.error,
  };
}
