import { isNotificationRoute } from "@taskboard/app/lib/notificationDestination";

/** The IPC channel main uses to tell the main window a notification was clicked. */
export const OPEN_ROUTE_CHANNEL = "notification:open-route";

/**
 * A click on an OS notification, as the renderer receives it. The renderer runs
 * the same open-notification code the bell and the in-app toast do: it marks
 * `notificationId` read and, when `path` is set, navigates there. Both are checked
 * again on arrival — a message over IPC is not trusted.
 */
export interface NotificationClick {
  notificationId: string;
  /** The in-app route (message included, as `?m=`), or null when it leads nowhere. */
  path: string | null;
}

/** The slice of BrowserWindow this needs, so it can be tested without Electron. */
export interface RouteWindow {
  isDestroyed(): boolean;
  webContents: {
    isLoading(): boolean;
    once(event: "did-finish-load", listener: () => void): unknown;
    send(channel: string, ...args: unknown[]): void;
  };
}

/**
 * What clicking an OS notification does: bring the app forward, then tell it to
 * show the notification's own target.
 *
 * `focus` comes first and may CREATE the window (the user closed it to the tray),
 * so the window is looked up afterwards. A window that is still loading cannot
 * hear the message yet — the renderer registers its listener as the page loads —
 * so the send waits for did-finish-load, the same rule deep links follow
 * (deep-link-forwarder.ts).
 *
 * The click carries its own id and `path`, computed from that notification when
 * it was raised: nothing is remembered between clicks, so an older notification
 * opens its own target, not the last one's. A notification with no target is still
 * sent (so it is marked read) with a null path: the user stays where they were.
 */
export function openNotificationTarget(
  click: NotificationClick,
  focus: () => void,
  getWindow: () => RouteWindow | null,
): void {
  focus();
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  const payload: NotificationClick = {
    notificationId: click.notificationId,
    path: isNotificationRoute(click.path) ? click.path : null,
  };
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send(OPEN_ROUTE_CHANNEL, payload);
  };
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
  else send();
}
