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
import type { ApiClient, InboxItemDTO, InboxItemKind, InboxPageDTO, MessageDTO, NotificationPageDTO } from "@taskboard/shared";
import { qk } from "./queryBridge";
import { mergeOlderMessages } from "./threadPagination";
import { flattenNotificationPages } from "./notificationPages";

/** Server default for thread history is 12 — see services/messaging-svc/internal/api/threads.go */
export const THREAD_PAGE_SIZE = 12;
export const NOTIFICATION_PAGE_SIZE = 10;

/** `read` false = the unread feed (default, `qk.notifications`); true = the read
 *  feed (`qk.notificationsRead`). The filter runs on the server. */
export function useNotificationPages(api: ApiClient, enabled: boolean, read = false) {
  return useInfiniteQuery({
    queryKey: read ? qk.notificationsRead : qk.notifications,
    queryFn: ({ pageParam }) =>
      api.notificationPage(pageParam as string | undefined, NOTIFICATION_PAGE_SIZE, read),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: NotificationPageDTO) => lastPage.nextCursor ?? undefined,
    enabled,
  });
}

export const flatNotificationPages = flattenNotificationPages;

/**
 * 25 per page, default. When peerId is given, the feed is narrowed to that
 * counterparty and cached under a separate key (`qk.inboxPeerFeed`) so the
 * all-feed's optimistic patches are never disturbed.
 *
 * `kinds` is passed to the SERVER rather than filtered out of the result,
 * because a page is a page of rows: filtering afterwards would leave a user
 * with a screenful of the excluded kind looking at an empty feed that still
 * says there is more.
 */
export function useInboxPages(api: ApiClient, peerId?: string, kinds?: InboxItemKind[]) {
  return useInfiniteQuery({
    // The key deliberately does NOT include `kinds`. It is not an oversight:
    // lib/inboxPatch writes this cache with an EXACT-key setQueryData, so any
    // suffix here would send every optimistic patch to a key nothing reads —
    // silently, because a write to a missing key is not an error. The Inbox is
    // the only caller and always asks for the same kinds, so there is one
    // shape per key and nothing to disambiguate.
    queryKey: peerId ? qk.inboxPeerFeed(peerId) : qk.unifiedInbox,
    queryFn: ({ pageParam }) => api.inbox(pageParam as string | undefined, 25, peerId, kinds),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: InboxPageDTO) => last.nextCursor ?? undefined,
  });
}

/**
 * Deleted Items — the same keyset feed with its visibility predicate inverted.
 *
 * A separate hook rather than a flag on the one above, because the two are
 * different CACHES that must never be confused: the live feed is patched
 * in place by lib/inboxPatch and by the WS bridge, and a deleted row arriving
 * through either would put mail back in the mailbox it was removed from. The
 * peer filter still applies, so picking a person narrows the wastebasket too.
 *
 * `enabled` keeps the request from firing at all while another folder is on
 * screen: this is a folder the user visits rarely, and prefetching a page of
 * everything they have thrown away is work nobody asked for.
 */
export function useDeletedMailPages(api: ApiClient, peerId?: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: peerId ? [...qk.deletedMail, peerId] : qk.deletedMail,
    queryFn: ({ pageParam }) =>
      api.inbox(pageParam as string | undefined, 25, peerId, ["MAIL"], true),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: InboxPageDTO) => last.nextCursor ?? undefined,
    enabled,
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
