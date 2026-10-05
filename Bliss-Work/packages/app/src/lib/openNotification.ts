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

/**
 * Flip the row and lower the badge BEFORE the request, so the UI answers the click
 * immediately; the server then has the last word. Failed: it still holds the row
 * unread, so refetch the list and the row comes back; otherwise just the count.
 */
export async function markNotificationRead(
  { qc, api }: Pick<NotificationActionDeps, "qc" | "api">,
  id: string,
): Promise<void> {
  const flipped = markNotificationPagesRead(qc, (n) => n.id === id);
  decrementUnreadCount(qc, flipped);
  const failed = await api.markNotificationRead(id).then(
    () => false,
    () => true,
  );
  void (failed ? qc.invalidateQueries({ queryKey: qk.notifications }) : refreshUnreadCount(qc));
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
