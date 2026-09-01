/**
 * Desktop notification preference — whether the user wants OS-level popups
 * for new messages, tasks, and calls.
 *
 * Stored client-side in localStorage. Shared by the Settings toggle
 * (routes/Settings.tsx) and every renderer call site that raises a
 * `Notification` (lib/callNotify.ts), so there is exactly one place that
 * decides what the key means and what "unset" defaults to.
 *
 * On Electron, the value is also mirrored to the main process (see
 * PlatformConfig.notificationPrefs) — the popups messages/tasks/calls raise
 * while the app is in the tray are shown by the main process via
 * apps/desktop/src/main/notifier.ts, which has no access to this
 * localStorage at all.
 */
const NOTIF_KEY = "tb.notifications.desktop";

export function loadDesktopNotifs(): boolean {
  try {
    return localStorage.getItem(NOTIF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveDesktopNotifs(on: boolean) {
  try {
    localStorage.setItem(NOTIF_KEY, on ? "on" : "off");
  } catch {
    /* localStorage may be unavailable in some Electron contexts */
  }
}
