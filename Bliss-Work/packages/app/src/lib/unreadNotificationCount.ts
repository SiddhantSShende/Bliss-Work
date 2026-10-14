import type { QueryClient } from "@tanstack/react-query";
import { qk } from "./queryKeys";

/**
 * The bell badge and the Tasks rail badge both read `qk.notificationsUnreadCount`,
 * a server-side count with its own cache entry — the bell from `unreadCount`
 * (every kind), the Tasks badge from `tasksUnreadCount` (TASK_* only). Patching
 * the notification LIST cache to `read` therefore never moves either; every
 * "mark read on view" flow has to adjust this entry as well.
 */

/** The cached shape of `api.notificationsUnreadCount()`. */
type UnreadCount = { unreadCount: number; tasksUnreadCount: number };

export function unreadBadgeLabel(count: number): string | null {
  if (count <= 0) return null;
  return count >= 100 ? "99+" : String(count);
}

/**
 * Optimistically lower the bell badge by `total` and the Tasks badge by
 * `tasks` (the TASK_*-kind subset of `total`; 0 when none of what changed was
 * a task notification), never below zero. A no-op until the count has
 * loaded — the refresh below then fetches it.
 */
export function decrementUnreadCount(qc: QueryClient, total: number, tasks = 0): void {
  qc.setQueryData<UnreadCount>(qk.notificationsUnreadCount, (prev) =>
    prev && {
      unreadCount: Math.max(0, prev.unreadCount - total),
      tasksUnreadCount: Math.max(0, prev.tasksUnreadCount - tasks),
    },
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
