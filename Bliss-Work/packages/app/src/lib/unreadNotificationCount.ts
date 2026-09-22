import type { QueryClient } from "@tanstack/react-query";
import { qk } from "./queryKeys";

/**
 * The bell badge and the Tasks rail dot both read `qk.notificationsUnreadCount`,
 * a server-side count with its own cache entry. Patching the notification LIST
 * cache to `read` therefore never moves them — every "mark read on view" flow
 * has to adjust this entry as well.
 */

/** The cached shape of `api.notificationsUnreadCount()`. */
type UnreadCount = { unreadCount: number };

/**
 * Optimistically lower the badge by `by`, never below zero. A no-op until the
 * count has loaded — the refresh below then fetches it.
 */
export function decrementUnreadCount(qc: QueryClient, by: number): void {
  qc.setQueryData<UnreadCount>(
    qk.notificationsUnreadCount,
    (prev) => prev && { ...prev, unreadCount: Math.max(0, prev.unreadCount - by) },
  );
}

/**
 * Refetch the count so the server, not the optimistic guess, has the last word.
 * Call it once the mark-read requests have settled: a request that failed leaves
 * its notification unread, and this puts the badge back.
 */
export function refreshUnreadCount(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.notificationsUnreadCount });
}
