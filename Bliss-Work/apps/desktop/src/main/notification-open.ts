import { isNotificationRoute } from "@taskboard/app/lib/notificationDestination";

/** The IPC channel main uses to tell the main window which route to show. */
export const OPEN_ROUTE_CHANNEL = "notification:open-route";

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
 * The click carries its own `path`, computed from that notification when it was
 * raised: nothing is remembered between clicks, so an older notification opens
 * its own target, not the last one's. A null path (no target for this kind)
 * only focuses, leaving the user where they were.
 */
export function openNotificationTarget(
  path: string | null,
  focus: () => void,
  getWindow: () => RouteWindow | null,
): void {
  focus();
  if (!isNotificationRoute(path)) return;
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send(OPEN_ROUTE_CHANNEL, path);
  };
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
  else send();
}
