/**
 * What clicking a notification does — the ONE implementation behind the bell's
 * rows, the in-app toast and the desktop OS popup, so they cannot drift apart.
 *
 *   mark read → (if it leads somewhere) navigate to the resource
 *
 * Opening the resource and landing on the right message is the destination's
 * job (a thread route plus `?m=<messageId>`, see notificationDestination.ts);
 * this only decides that it happens, and in what order.
 */
import { useCallback } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { useRuntime } from "./runtime";
import { qk } from "./queryKeys";
import { decrementUnreadCount, refreshUnreadCount } from "./unreadNotificationCount";
import { markNotificationPagesRead } from "./notificationPages";
import { notificationRoute, openNotificationRoute, type NotificationTarget } from "./notificationDestination";

export interface NotificationActionDeps {
  qc: QueryClient;
  api: { markNotificationRead: (id: string) => Promise<unknown> };
  navigate: (to: string, options?: { replace?: boolean }) => void;
  /** Read at click time: a toast can be clicked long after it was raised. */
  currentPath: () => string;
}

/** A notification as a click sees it: its id plus whatever decides where it leads. */
export type OpenableNotification = { id: string } & NotificationTarget;

/** Ids whose read request is on the wire. A row clicked while the panel closes, or a
 *  panel closed and reopened in quick succession, must not send the same request twice. */
const readsInFlight = new Set<string>();

/** Whether a read request for this notification has not finished yet. */
export function isReadInFlight(id: string): boolean {
  return readsInFlight.has(id);
}

/**
 * Flip the rows and lower the badge BEFORE the requests, so the UI answers at once;
 * the server then has the last word. Anything that failed is still unread there,
 * so every notification list and the count are refetched and the rows come back.
 * When all succeeded the count is refetched, the rows are patched read again (a
 * feed fetched while the requests were in flight may have brought them back as
 * unread) and the read feed is invalidated so it lists them next time. Ids already
 * in flight are left to the request that is already carrying them.
 */
export async function markNotificationsRead(
  { qc, api }: Pick<NotificationActionDeps, "qc" | "api">,
  ids: string[],
): Promise<void> {
  const todo = [...new Set(ids)].filter((id) => !readsInFlight.has(id));
  if (todo.length === 0) return;
  todo.forEach((id) => readsInFlight.add(id));
  const wanted = new Set(todo);
  const flip = () => markNotificationPagesRead(qc, (n) => wanted.has(n.id));
  const { total, tasks } = flip();
  decrementUnreadCount(qc, total, tasks);
  let failed = false;
  try {
    const results = await Promise.all(todo.map((id) => api.markNotificationRead(id).then(() => true, () => false)));
    failed = results.includes(false);
  } finally {
    todo.forEach((id) => readsInFlight.delete(id));
  }
  if (failed) {
    // `qk.notifications` is the prefix of both feeds and the count.
    void qc.invalidateQueries({ queryKey: qk.notifications });
    return;
  }
  flip();
  void qc.invalidateQueries({ queryKey: qk.notificationsRead });
  void refreshUnreadCount(qc);
}

export function markNotificationRead(
  deps: Pick<NotificationActionDeps, "qc" | "api">,
  id: string,
): Promise<void> {
  return markNotificationsRead(deps, [id]);
}

/**
 * The click. `route` is already resolved (null = leads nowhere) so a caller that
 * received a route over IPC and one holding a full record share this path; use
 * `openNotification` for the latter.
 */
export function openNotificationAt(deps: NotificationActionDeps, id: string, route: string | null): void {
  void markNotificationRead(deps, id);
  if (route) openNotificationRoute(deps.navigate, deps.currentPath(), route);
}

export function openNotification(deps: NotificationActionDeps, notification: OpenableNotification): void {
  openNotificationAt(deps, notification.id, notificationRoute(notification));
}

/** The handlers for components inside the router: `open` for a click, `markRead` for "Mark read". */
export function useNotificationActions() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const markRead = useCallback((id: string) => markNotificationRead({ qc, api }, id), [qc, api]);
  const openAt = useCallback(
    (id: string, route: string | null) => openNotificationAt({ qc, api, navigate, currentPath: () => pathname }, id, route),
    [qc, api, navigate, pathname],
  );
  const open = useCallback((n: OpenableNotification) => openAt(n.id, notificationRoute(n)), [openAt]);
  return { markRead, open, openAt };
}
