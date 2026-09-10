import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, FileIcon, Loader2, X } from "lucide-react";
import type { MediaItem } from "../lib/chatEnvelope";
import { canPreviewDocInApp, prettySize } from "../lib/chatEnvelope";
import { useBlobUrl } from "../lib/useBlobUrl";

/**
 * Full-screen viewer for the images, videos and previewable documents (PDF,
 * plain text — see `canPreviewDocInApp`) in one message. Every other type —
 * Office documents, archives, anything else — still opens here, showing an
 * explicit "Preview not available" message (`UnsupportedPreview`) instead of
 * being unreachable.
 *
 * Built on its own overlay rather than the shared `Modal` because a lightbox
 * wants edge-to-edge black with no card chrome, but it reproduces the same
 * accessibility behaviour: Escape to close, focus restored on exit, and
 * `aria-modal` so screen readers treat the page behind it as inert.
 */
export function Lightbox({
  items,
  index,
  urlFor,
  onClose,
  onIndexChange,
}: {
  items: MediaItem[];
  index: number;
  urlFor: (id: string | undefined) => string | undefined;
  onClose: () => void;
  onIndexChange: (next: number) => void;
}) {
  const [zoomed, setZoomed] = useState(false);
  const current = items[index];

  const go = useCallback(
    (delta: number) => {
      if (items.length < 2) return;
      // Wrap, so ← from the first item lands on the last.
      onIndexChange((index + delta + items.length) % items.length);
      setZoomed(false);
    },
    [index, items.length, onIndexChange],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    // Restore focus to whatever opened the lightbox, so keyboard users are not
    // dumped at the top of the document on close.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => {
      window.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [go, onClose]);

  if (!current) return null;
  const url = urlFor(current.id);
  const isVideo = current.mime.startsWith("video/");
  const isDoc = canPreviewDocInApp(current.mime);
  const isImage = current.mime.startsWith("image/");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={current.name}
      className="fixed inset-0 z-[100] flex flex-col bg-black/95 backdrop-blur-sm"
      // Clicking the backdrop closes; clicks inside the media do not bubble.
      onClick={onClose}
    >
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{current.name}</div>
          <div className="text-xs text-white/60">
            {prettySize(current.size)}
            {items.length > 1 ? ` · ${index + 1} of ${items.length}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* No download control, by product decision — attachments are for
              viewing in the app, not for saving. The server ignores ?dl=1 too
              (internal/api/attachments.go), so a hand-crafted link cannot
              re-enable it. */}
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="rounded-full p-2 text-white/80 hover:bg-white/10 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4">
        {items.length > 1 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
            aria-label="Previous"
            className="absolute left-2 z-10 rounded-full bg-black/40 p-2 text-white/80 hover:bg-black/70 hover:text-white"
          >
            <ChevronLeft size={22} />
          </button>
        )}

        {!url ? (
          <div className="text-sm text-white/60">Loading…</div>
        ) : isVideo ? (
          <video
            src={url}
            controls
            autoPlay
            playsInline
            className="max-h-full max-w-full"
            onClick={(e) => e.stopPropagation()}
          />
        ) : isDoc ? (
          <DocFrame url={url} name={current.name} />
        ) : isImage ? (
          <img
            src={url}
            alt={current.name}
            onClick={(e) => {
              e.stopPropagation();
              setZoomed((z) => !z);
            }}
            className={
              zoomed
                ? "max-h-none max-w-none cursor-zoom-out"
                : "max-h-full max-w-full cursor-zoom-in object-contain"
            }
          />
        ) : (
          <UnsupportedPreview name={current.name} />
        )}

        {items.length > 1 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
            aria-label="Next"
            className="absolute right-2 z-10 rounded-full bg-black/40 p-2 text-white/80 hover:bg-black/70 hover:text-white"
          >
            <ChevronRight size={22} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Shown for a type this app has no in-app renderer for — Office documents,
 * archives, and anything else outside `canPreviewDocInApp` plus images/video.
 * There is no fallback to open or download it: the server forces
 * `Content-Disposition: attachment` for everything outside its own inline
 * allowlist (media/mime.go), so a link out would just be a download wearing
 * an Open label. This replaces that dead end with an explicit reason instead
 * of a click that silently does nothing.
 */
function UnsupportedPreview({ name }: { name: string }) {
  return (
    <div
      className="flex max-w-xs flex-col items-center gap-2 text-center text-sm text-white/70"
      onClick={(e) => e.stopPropagation()}
    >
      <FileIcon size={28} className="text-white/50" />
      <span className="max-w-full truncate font-medium text-white/90">{name}</span>
      <span>Preview not available for this file type</span>
    </div>
  );
}

/**
 * In-app preview for a PDF or plain-text attachment.
 *
 * `url` is fetched into a `blob:` object URL (see useBlobUrl) rather than
 * pointed at directly: a browser renders `application/pdf`/`text/plain`
 * bytes natively inside an <iframe>, but only a `blob:` source clears this
 * app's CSP on the packaged desktop build. A failed fetch (offline, an
 * expired signed link) falls back to the same "open elsewhere" affordance
 * the rest of the app uses for documents it cannot preview at all.
 */
function DocFrame({ url, name }: { url: string; name: string }) {
  const preview = useBlobUrl(url);

  if (preview.error) {
    return (
      <div
        className="flex max-w-xs flex-col items-center gap-2 text-center text-sm text-white/70"
        onClick={(e) => e.stopPropagation()}
      >
        <AlertCircle size={20} />
        <span>{preview.error}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-white underline underline-offset-2 hover:text-white/80"
        >
          Open in browser instead
        </a>
      </div>
    );
  }

  if (!preview.url) {
    return (
      <div className="flex items-center gap-2 text-sm text-white/60">
        <Loader2 size={16} className="animate-spin" /> Loading preview…
      </div>
    );
  }

  return (
    <iframe
      src={preview.url}
      title={name}
      className="h-full max-h-[85vh] w-full max-w-4xl rounded-lg bg-white"
      onClick={(e) => e.stopPropagation()}
    />
  );
}
