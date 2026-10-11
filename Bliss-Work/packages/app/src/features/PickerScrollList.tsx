import { useCallback, useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { PICKER_TONES, type PickerTone } from "./pickerTone";

/** How close to the bottom (px) the scroll position gets before the next page is asked for. */
const NEAR_BOTTOM_PX = 96;

/**
 * The scrolling body of a server-paged picker: a box with a FIXED height that is there,
 * scrollbar and all, the moment it mounts — it never grows with its content, so a long
 * list cannot make the surrounding dialog taller. Only the box scrolls.
 *
 * It asks for the next page (`onNearEnd`) when the scroll position comes within
 * NEAR_BOTTOM_PX of the bottom, and also whenever the rows loaded so far do not yet
 * overflow the box (a short first page, a narrow search result with more behind it):
 * without that there would be nothing to scroll and so no way to reach the rest.
 * `onNearEnd` may be called freely; the data hook ignores it while a page is in flight.
 *
 * The rows are the caller's (`children`), so People and Channels share this one pattern.
 */
export function PickerScrollList({
  tone,
  label,
  isLoading,
  isError,
  isLoadingMore,
  hasMore,
  isEmpty,
  onNearEnd,
  onRetry,
  text,
  children,
}: {
  tone: PickerTone;
  /** Accessible name of the list. */
  label: string;
  isLoading: boolean;
  isError: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  isEmpty: boolean;
  onNearEnd: () => void;
  onRetry: () => void;
  text: { loading: string; loadingMore: string; error: string; retry: string; empty: string };
  children: React.ReactNode;
}) {
  const c = PICKER_TONES[tone];
  const box = useRef<HTMLDivElement>(null);

  const checkEnd = useCallback(() => {
    const el = box.current;
    if (!el || !hasMore) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) onNearEnd();
  }, [hasMore, onNearEnd]);

  // After every render that changed the rows: is there still nothing to scroll? clientHeight
  // is 0 where there is no layout (a hidden tab, jsdom), and then there is no box to fill.
  useEffect(() => {
    const el = box.current;
    if (el && el.clientHeight > 0 && hasMore && !isLoading && !isLoadingMore && el.scrollHeight <= el.clientHeight) {
      onNearEnd();
    }
  });

  return (
    <div
      ref={box}
      onScroll={checkEnd}
      role="region"
      aria-label={label}
      aria-busy={isLoading || isLoadingMore}
      // h-72 and overflow-y-auto, not max-h: the box is the same size empty, loading or
      // full, which is what keeps the dialog's height stable.
      className={`h-72 shrink-0 overflow-y-auto overscroll-contain rounded-lg border p-1 ${c.list}`}
    >
      {isLoading ? (
        <p className={`flex items-center gap-2 px-2 py-3 text-sm ${c.muted}`} role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {text.loading}
        </p>
      ) : isError && isEmpty ? (
        <div className="px-2 py-3 text-sm" role="alert">
          <p className="text-danger">{text.error}</p>
          <button type="button" onClick={onRetry} className="mt-1 font-medium text-accent hover:underline">
            {text.retry}
          </button>
        </div>
      ) : isEmpty ? (
        <p className={`px-2 py-3 text-sm ${c.muted}`}>{text.empty}</p>
      ) : (
        <>
          {children}
          {isLoadingMore && (
            <p className={`flex items-center justify-center gap-2 px-2 py-2 text-xs ${c.muted}`} role="status">
              <Loader2 size={13} className="animate-spin" aria-hidden />
              {text.loadingMore}
            </p>
          )}
          {isError && (
            <div className="px-2 py-2 text-center text-xs" role="alert">
              <span className="text-danger">{text.error}</span>{" "}
              <button type="button" onClick={onRetry} className="font-medium text-accent hover:underline">
                {text.retry}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
