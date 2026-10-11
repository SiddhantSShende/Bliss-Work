/** The IPC channel main uses to tell the main window to open a task's chat
 *  discussion. Distinct from notification-open.ts's OPEN_ROUTE_CHANNEL, which
 *  requires a real notification id and marks it read — this does neither. */
export const TASK_CHAT_OPEN_CHANNEL = "task:open-chat";

/** What the sticky overlay's Chat button sends, forwarded verbatim to the
 *  main window. */
export interface TaskChatOpen {
  taskId: string;
}

/** The slice of BrowserWindow this needs — see notification-open.ts's
 *  identical RouteWindow, kept separate so neither file depends on the other. */
export interface TaskChatWindow {
  isDestroyed(): boolean;
  webContents: {
    isLoading(): boolean;
    once(event: "did-finish-load", listener: () => void): unknown;
    send(channel: string, ...args: unknown[]): void;
  };
}

/**
 * The sticky-overlay window has no router of its own, so its Chat button
 * cannot open a conversation itself. This brings the main window forward
 * (creating it if the user closed it to the tray, same as a notification
 * click) and tells it which task to open chat for; the renderer resolves the
 * actual DM/channel target from data already in its query cache.
 *
 * `focus` comes first and may CREATE the window, so it is looked up
 * afterwards. A window still loading cannot hear the message yet — the
 * renderer registers its listener as the page loads — so the send waits for
 * did-finish-load, mirroring openNotificationTarget.
 */
export function openTaskChat(
  payload: TaskChatOpen,
  focus: () => void,
  getWindow: () => TaskChatWindow | null,
): void {
  focus();
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send(TASK_CHAT_OPEN_CHANNEL, payload);
  };
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
  else send();
}
