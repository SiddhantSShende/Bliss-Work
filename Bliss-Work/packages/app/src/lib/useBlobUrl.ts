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
 *
 * `mime` is the type the caller has decided it is willing to render. A `blob:`
 * URL inherits the app's origin, so bytes the server labelled `text/html` and
 * showed in an iframe would run as script in the app; when `mime` is given the
 * bytes are re-wrapped with exactly that type, whatever the response said.
 * The `error` text is diagnostic only — callers show their own localised copy.
 */
export function useBlobUrl(source: string | undefined, mime?: string): BlobPreview {
  const [state, setState] = useState<{ url?: string; error?: string }>({});

  useEffect(() => {
    setState({});
    if (!source) return;

    let objectUrl: string | undefined;
    let cancelled = false;
    // Closing the preview mid-download must stop the download, not just ignore it.
    const abort = new AbortController();

    fetch(source, { signal: abort.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Preview failed to load (${res.status})`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(mime ? new Blob([blob], { type: mime }) : blob);
        setState({ url: objectUrl });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ error: err instanceof Error ? err.message : "Couldn't load preview" });
      });

    return () => {
      cancelled = true;
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, mime]);

  return {
    url: state.url,
    isLoading: !!source && !state.url && !state.error,
    error: state.error,
  };
}
