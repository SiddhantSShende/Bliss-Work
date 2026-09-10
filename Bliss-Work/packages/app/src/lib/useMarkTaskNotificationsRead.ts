import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiClient, NotificationDTO } from "@taskboard/shared";
import { qk } from "./queryBridge";

/**
 * Mark-as-read on view: when a set of tasks becomes visible on the Tasks page,
 * clear any bell notification tied to one of them. Mirrors MailTask.tsx's
 * per-task version of this same fix (opening a task IS reading its
 * notification), generalized to a list. Same shape as useMarkPeerRead:
 * ref-based dedupe so a remount doesn't refire, optimistic cache patch so the
 * bell badge/drawer clear instantly, best-effort real calls with
 * delete-on-failure so a failed call gets retried on the next mount.
 */
export function useMarkTaskNotificationsRead(api: ApiClient, tasks: { taskId: string }[]) {
  const qc = useQueryClient();
  const markedRef = useRef<Set<string>>(new Set());

  // Same query AppShell already runs for the bell — TanStack dedupes the
  // underlying request (see useAvailability's identical reasoning in
  // TasksList.tsx), so this is a subscription to the existing cache entry,
  // not an extra fetch. A plain qc.getQueryData() snapshot (the previous
  // approach) never re-ran this effect when a NEW notification arrived for a
  // task already in `tasks`: nothing here re-rendered on a cache update it
  // wasn't subscribed to, so the bell stayed lit until the view was closed
  // and reopened.
  const { data: notifications = [] } = useQuery({
    queryKey: qk.notifications,
    queryFn: () => api.notifications(),
  });
  const taskIds = new Set(tasks.map((t) => t.taskId));
  const unreadForTasks = notifications.filter((n) => n.taskId && taskIds.has(n.taskId) && !n.read);
  // Changes whenever the SET of relevant unread ids does — not just when
  // `tasks` does — so a new notification landing on an already-visible task
  // re-triggers this, not only a change to which tasks are visible.
  const unreadSignature = unreadForTasks
    .map((n) => n.id)
    .sort()
    .join(",");

  useEffect(() => {
    const unread = unreadForTasks.filter((n) => !markedRef.current.has(n.id));
    if (unread.length === 0) return;

    unread.forEach((n) => markedRef.current.add(n.id));
    const unreadIds = new Set(unread.map((n) => n.id));
    qc.setQueryData<NotificationDTO[]>(qk.notifications, (prev) =>
      (prev ?? []).map((n) => (unreadIds.has(n.id) ? { ...n, read: true } : n)),
    );
    void Promise.all(
      unread.map((n) =>
        api.markNotificationRead(n.id).catch(() => {
          markedRef.current.delete(n.id); // allow a retry on the next mount
        }),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadSignature]);
}
