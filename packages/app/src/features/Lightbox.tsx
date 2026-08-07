import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import type { MediaItem } from "../lib/chatEnvelope";
import { prettySize } from "../lib/chatEnvelope";

/**
 * Full-screen viewer for the images and videos in one message.
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
          {url && (
            <a
              // ?dl=1 makes the server send Content-Disposition: attachment even
              // for types it would otherwise display inline.
              href={`${url}&dl=1`}
              download={current.name}
              title="Download"
              aria-label={`Download ${current.name}`}
              className="rounded-full p-2 text-white/80 hover:bg-white/10 hover:text-white"
            >
              <Download size={18} />
            </a>
          )}
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
        ) : (
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
