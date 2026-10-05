import { isNotificationRoute } from "@taskboard/app/lib/notificationDestination";

/**
 * The location hash the renderer should move to for a route main sent it, or
 * null when it should do nothing.
 *
 * Null for a path that is not one the app itself could have produced — a
 * message arriving over IPC is checked, not trusted — and for a route that is
 * already showing, so a click on a notification for the open channel does not
 * add a history entry. Anything else is an explicit navigation and wins over
 * whatever page the window was on.
 */
export function hashForRoute(path: unknown, currentHash: string): string | null {
  if (!isNotificationRoute(path)) return null;
  const next = `#${path}`;
  return next === currentHash ? null : next;
}
