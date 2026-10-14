import { useEffect, useRef } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@taskboard/shared";
import { qk } from "./queryKeys";
import { decrementUnreadCount, refreshUnreadCount } from "./unreadNotificationCount";
import { markNotificationPagesRead } from "./notificationPages";

/** The server takes at most this many task ids per call. */
const TASK_IDS_PER_CALL = 200;

/**
 * Record that these tasks are being viewed: their unread notifications become
 * read ON THE SERVER, and the caches follow what the server says.
 *
 * Read state has one home — the notification row. This used to find "the
 * notifications for these tasks" in the panel's list cache and mark each by id,
 * so it did nothing at all until the bell had been opened once this session
 * (the cache was empty and nothing else fills it), and it never saw a
 * notification beyond the first loaded page. Asking the server by task id has
 * neither problem, and the server's own `notification.read` events carry the
 * change to every other open session.
 *
 * Only notifications tied to a named task are touched: ones with no task, or for
 * a task not listed, keep their unread state and keep counting in the badge. A
 * read notification is never removed — it stays in the panel's history.
 *
 * Never throws: a failure leaves the notification unread, which is the truth.
 */
export async function markTaskNotificationsRead(
  api: ApiClient,
  qc: QueryClient,
  taskIds: string[],
): Promise<void> {
  const ids = [...new Set(taskIds)];
  for (let i = 0; i < ids.length; i += TASK_IDS_PER_CALL) {
    const chunk = ids.slice(i, i + TASK_IDS_PER_CALL);
    let updated: number;
    try {
      ({ updated } = await api.markTaskNotificationsRead(chunk));
    } catch {
      continue; // nothing was marked for this chunk; the badge is still right
    }
    if (updated === 0) continue;

    const tasks = new Set(chunk);
    markNotificationPagesRead(qc, (n) => !!n.taskId && tasks.has(n.taskId));
    // The badge is its own server-side count (see unreadNotificationCount.ts), so
    // patching the list never moves it: lower it by what the server says it
    // changed, then let a refetch have the last word. Every row read-by-tasks
    // touches has a task_id, so it is a TASK_* notification — `updated` lowers
    // the Tasks badge by the same amount as the bell.
    decrementUnreadCount(qc, updated, updated);
    // The read feed does not hold these rows yet — it will, next time it loads.
    void qc.invalidateQueries({ queryKey: qk.notificationsRead });
    void refreshUnreadCount(qc);
  }
}

/**
 * Mark-as-read on view: while a set of tasks is on screen, their notifications
 * are read. Runs when the set of visible tasks changes and when the unread count
 * RISES (a new notification may be for a task already in view), and only while
 * something is unread at all. A fall in the count — including our own — does not
 * re-run it.
 *
 * The count is the same query AppShell runs for the bell (TanStack dedupes it),
 * so this reads the badge's own number rather than a copy.
 */
export function useMarkTaskNotificationsRead(api: ApiClient, tasks: { taskId: string }[]) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: qk.notificationsUnreadCount,
    queryFn: () => api.notificationsUnreadCount(),
  });
  const unreadCount = data?.unreadCount ?? 0;
  const taskIds = [...new Set(tasks.map((t) => t.taskId))].sort();
  const signature = taskIds.join(",");
  const last = useRef({ signature: "", unreadCount: 0 });

  useEffect(() => {
    const before = last.current;
    last.current = { signature, unreadCount };
    if (!signature || unreadCount === 0) return;
    if (signature === before.signature && unreadCount <= before.unreadCount) return;
    void markTaskNotificationsRead(api, qc, taskIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, unreadCount]);
}
