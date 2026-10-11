import { useCallback, useEffect, useRef } from "react";
import { AlertCircle } from "lucide-react";
import { Spinner } from "@taskboard/ui";

/** How close to the bottom (px) counts as "near" — far enough ahead that the next
 *  page is usually there before the user reaches the end. */
const NEAR_BOTTOM_PX = 96;

/**
 * The scrolling body of a server-paged picker.
 *
 * It owns three things and nothing else: a box whose size does NOT depend on how
 * many rows there are, the "ask for more" trigger, and the loading / empty / error
 * states. What a row looks like, what selecting it does and where the rows come
 * from (usePagedPicker) are the caller's.
 *
 * ── The box ─────────────────────────────────────────────────────────────────
 * It fills whatever room its parent gives it (`flex-1`, with a `min-h` floor) but
 * scrolls inside it: the scroller is absolutely positioned within, so a thousand
 * rows can never make the box — or the dialog around it — taller. The scrollbar is
 * therefore there from the moment the list has more rows than fit, with no click to
 * reveal it. An optional `note` is a strip INSIDE that box, above the scroller:
 * it takes room from the rows, never from the dialog, so two lists that differ
 * only by a note are the same size.
 *
 * ── The trigger ─────────────────────────────────────────────────────────────
 * `onLoadMore` fires when the scroller is near its end (on scroll) and also after
 * every render in which the rows do not yet fill the box — a tall window can show
 * the whole first page without ever scrolling. Both can fire constantly; the caller
 * (usePagedPicker.loadMore) is the one that makes that safe.
 */
export function PagedListBox({
  label,
  count,
  isLoading,
  isRefreshing,
  isLoadingMore,
  isError,
  hasMore,
  onLoadMore,
  onRetry,
  copy,
  note,
  children,
}: {
  label: string;
  /** Rows currently rendered. */
  count: number;
  isLoading: boolean;
  isRefreshing: boolean;
  isLoadingMore: boolean;
  isError: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  copy: { loading: string; loadingMore: string; empty: string; error: string; retry: string };
  /** A line of guidance shown above the rows, inside the box. */
  note?: string;
  children: React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);

  const maybeLoadMore = useCallback(() => {
    const el = scroller.current;
    if (el && hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) onLoadMore();
  }, [hasMore, onLoadMore]);

  // Rows that do not reach the bottom of the box give the user nothing to scroll.
  useEffect(maybeLoadMore, [maybeLoadMore, count, isLoadingMore, isRefreshing]);

  return (
    <div className="flex min-h-[20rem] flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
      {note && <p className="shrink-0 border-b border-border/60 bg-surface-2 px-3 py-1.5 text-xs text-muted">{note}</p>}
      <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={maybeLoadMore}
        aria-busy={isLoading || isRefreshing || isLoadingMore}
        // tabIndex: a scroll area with nothing focusable in it must still be reachable by keyboard.
        tabIndex={count === 0 ? 0 : -1}
        aria-label={label}
        className="absolute inset-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
      >
        {isLoading ? (
          <p role="status" className="flex h-full items-center justify-center gap-2 text-sm text-muted">
            <Spinner className="shrink-0" /> {copy.loading}
          </p>
        ) : isError && count === 0 ? (
          <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted">
            <AlertCircle size={18} aria-hidden />
            {copy.error}
            <button type="button" onClick={onRetry} className="rounded-lg px-2 py-1 font-medium text-accent hover:bg-accent-soft">
              {copy.retry}
            </button>
          </div>
        ) : count === 0 ? (
          <p className="flex h-full items-center justify-center px-4 text-center text-sm text-muted">{copy.empty}</p>
        ) : (
          <ul className={`m-0 list-none p-1 transition-opacity ${isRefreshing ? "opacity-60" : ""}`}>
            {children}
            {isLoadingMore && (
              <li role="status" className="flex items-center justify-center gap-2 py-3 text-xs text-muted">
                <Spinner className="shrink-0" /> {copy.loadingMore}
              </li>
            )}
            {isError && (
              <li className="flex items-center justify-center gap-2 py-3 text-xs text-muted" role="alert">
                {copy.error}
                <button type="button" onClick={onRetry} className="font-medium text-accent hover:underline">
                  {copy.retry}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
      </div>
    </div>
  );
}
