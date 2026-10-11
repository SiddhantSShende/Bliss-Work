import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";

/** Rows asked for per request. Big enough to fill the picker and then some, small
 *  enough that the first paint never waits on a large organisation. */
export const PICKER_PAGE_SIZE = 30;

/**
 * A server-paged, server-searched list for a picker: the first page on open, the
 * next one on demand, appended.
 *
 *  - `query` is the SETTLED search text (debounce it first, see useDebouncedValue).
 *    A new query is a new list: paging starts again from zero and rows from the
 *    old query are never mixed into it — they stay on screen only until the first
 *    page of the new one lands, so the list does not flash empty while typing.
 *  - `loadMore` is safe to call from a scroll handler: it does nothing while a page
 *    is in flight (a ref latch — a state flag lags a render behind fast scrolling),
 *    after the last page, or while the first page is still loading.
 *  - The last page is the first SHORT one (fewer rows than asked for). A server that
 *    ignores `limit` and returns everything is therefore also treated as complete.
 *  - Rows are de-duplicated by id across pages (an overlap can only keep the first),
 *    and `matches`, when given, is applied to what comes back so a server that
 *    ignores `q` still shows only what was searched for.
 *
 * Selection is NOT this hook's business: it lives with the caller, by id, so it
 * survives pages, searches and tab switches by construction.
 */
export function usePagedPicker<T extends { id: string }>({
  cacheKey,
  query,
  enabled = true,
  pageSize = PICKER_PAGE_SIZE,
  fetchPage,
  matches,
}: {
  /** Names the list (e.g. "people"); the query text and page size are appended. */
  cacheKey: string;
  query: string;
  enabled?: boolean;
  pageSize?: number;
  fetchPage: (args: { q: string; offset: number; limit: number }) => Promise<T[]>;
  matches?: (item: T, q: string) => boolean;
}) {
  const q = query.trim();
  const inFlight = useRef(false);

  const list = useInfiniteQuery({
    queryKey: ["picker", cacheKey, pageSize, q],
    queryFn: ({ pageParam }) => fetchPage({ q, offset: pageParam, limit: pageSize }),
    initialPageParam: 0,
    // Offset is rows RECEIVED, not rows kept: de-duplication below must not shift it.
    getNextPageParam: (last, all) => (last.length === pageSize ? all.reduce((n, p) => n + p.length, 0) : undefined),
    placeholderData: keepPreviousData,
    enabled,
    staleTime: 30_000,
    retry: false,
  });

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const page of list.data?.pages ?? []) {
      for (const item of page) {
        if (seen.has(item.id) || (matches && !matches(item, q))) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
    // `matches` is a pure function of its arguments; callers pass a stable one.
  }, [list.data, matches, q]);

  const { hasNextPage, isFetching, isFetchingNextPage, isPlaceholderData, fetchNextPage } = list;
  const loadMore = useCallback(() => {
    // Not while the rows on screen belong to the PREVIOUS query: the next offset would
    // be that list's, not this one's.
    if (inFlight.current || !hasNextPage || isFetching || isPlaceholderData) return;
    inFlight.current = true;
    void fetchNextPage({ cancelRefetch: false }).finally(() => {
      inFlight.current = false;
    });
  }, [hasNextPage, isFetching, isPlaceholderData, fetchNextPage]);

  return {
    items,
    /** The first page of the current list has not arrived (and there is nothing to show yet). */
    isLoading: list.isPending,
    /** A search is replacing rows that are still on screen. */
    isRefreshing: isPlaceholderData,
    isLoadingMore: isFetchingNextPage,
    hasMore: hasNextPage,
    isError: list.isError,
    loadMore,
    retry: () => void list.refetch(),
  };
}
