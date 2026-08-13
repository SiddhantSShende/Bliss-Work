/**
 * TanStack useInfiniteQuery wrappers for the two cursor-paginated views:
 *
 *   useInboxPages(api)            — keyset over inbox_items (25 items/page)
 *   useThreadMessages(api, id, …) — reverse paged thread history (12 msg/page)
 *
 * Both expose a `flat` array of the merged pages so consumers don't have to
 * re-flatten on every render.
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ApiClient, InboxItemDTO, InboxPageDTO, MessageDTO } from "@taskboard/shared";
import { qk } from "./queryBridge";
import { mergeOlderMessages, oldestSeq } from "./threadPagination";

/** Server default for thread history is 12 — see services/messaging-svc/internal/api/threads.go */
export const THREAD_PAGE_SIZE = 12;

/** 25 per page, default. When peerId is given, the feed is narrowed to that
 *  counterparty and cached under a separate key (`qk.inboxPeerFeed`) so the
 *  all-feed's optimistic patches are never disturbed. */
export function useInboxPages(api: ApiClient, peerId?: string) {
  return useInfiniteQuery({
    queryKey: peerId ? qk.inboxPeerFeed(peerId) : qk.unifiedInbox,
    queryFn: ({ pageParam }) => api.inbox(pageParam as string | undefined, 25, peerId),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: InboxPageDTO) => last.nextCursor ?? undefined,
  });
}

/** Flatten infinite-query pages to a single InboxItemDTO[]. */
export function flatInbox(data: { pages: InboxPageDTO[] } | undefined): InboxItemDTO[] {
  if (!data) return [];
  return data.pages.flatMap((p) => p.items);
}

/**
 * Reverse-paged thread history. Page tail = next `beforeSeq` (the lowest seq
 * we've loaded so far). Pages aren't infinite-merged into the cache key; we
 * fold them via mergeOlderMessages into one ascending array per thread.
 *
 * `pageSize` defaults to THREAD_PAGE_SIZE (12) and exists primarily for tests;
 * production callers should leave it default so the server-side cap matches.
 */
export function useThreadMessages(
  api: ApiClient,
  threadId: string,
  pageSize: number = THREAD_PAGE_SIZE,
) {
  return useInfiniteQuery({
    queryKey: qk.threadMessages(threadId),
    queryFn: ({ pageParam }) =>
      api.threadMessages(threadId, pageParam as number | undefined, pageSize),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage: MessageDTO[], allPages: MessageDTO[][]) => {
      // A short last page (or empty) means we've hit the head of the thread.
      if (!lastPage.length || lastPage.length < pageSize) return undefined;
      // Server returns DESC by seq; the smallest seq in the last batch is the
      // next beforeSeq. allPages[0] is the newest batch from page 1.
      const minSeq = Math.min(...allPages.flat().map((m) => m.seq));
      return minSeq;
    },
  });
}

/** Flatten + dedupe a thread's pages into one seq-asc array. */
export function flatThreadMessages(
  data: { pages: MessageDTO[][] } | undefined,
): MessageDTO[] {
  if (!data) return [];
  let out: MessageDTO[] = [];
  // Pages come newest-first (DESC); fold each as "older" so we end up asc.
  for (const page of data.pages) out = mergeOlderMessages(out, page);
  return out;
}

/** Convenience: smallest currently-loaded seq for a thread, used to drive the
 *  next beforeSeq query manually if useInfiniteQuery isn't desired. */
export const lowestLoadedSeq = oldestSeq;
