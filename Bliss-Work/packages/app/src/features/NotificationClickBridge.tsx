import { useEffect } from "react";
import { useRuntime } from "../lib/runtime";
import { useNotificationActions } from "../lib/openNotification";
import { isNotificationRoute } from "../lib/notificationDestination";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs a click on an OS notification popup (Electron only) through the same
 * mark-read-and-open code the bell and the in-app toast use.
 *
 * The click arrives over IPC, so both fields are checked again: the id must be a
 * UUID, and a path the app could not itself have produced is dropped (the
 * notification is still marked read; the user just stays where they are).
 * Mounted in the signed-in shell, so a click made while signed out waits.
 */
export function NotificationClickBridge() {
  const { config } = useRuntime();
  const { openAt } = useNotificationActions();

  useEffect(
    () =>
      config.onNotificationClick?.(({ notificationId, path }) => {
        if (!UUID.test(notificationId)) return;
        openAt(notificationId, isNotificationRoute(path) ? path : null);
      }),
    [config, openAt],
  );
  return null;
}
