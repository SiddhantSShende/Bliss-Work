/**
 * Where a notification leads — one answer for the bell, the live toast and the
 * desktop popup.
 *
 * The destination comes ONLY from the server-provided record (its kind and ids),
 * never from the notification's text, and an id is used only if it is a UUID.
 * That keeps a crafted or corrupted record from steering the app to an arbitrary
 * route; anything unusable falls back to the section's own list. Whether the
 * user may open the target is still the server's call when the page loads.
 *
 * Pure and dependency-free so the desktop main process can import it too.
 */
import type { NotificationDTO } from "@taskboard/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The fields of a notification record that decide where it leads. */
export interface NotificationTarget {
  kind: NotificationDTO["kind"];
  taskId?: string | null;
  channelId?: string | null;
  conversationId?: string | null;
  callId?: string | null;
}

const id = (value: string | null | undefined): string | null => (value && UUID.test(value) ? value : null);

export function notificationDestination(notification: NotificationTarget): string {
  switch (notification.kind) {
    case "CHANNEL_ADDED":
    case "CHANNEL_CREATED":
    case "CHANNEL_MESSAGE": {
      const channelId = id(notification.channelId);
      return channelId ? `/app/channels/${channelId}` : "/app/channels";
    }
    case "DM_MESSAGE": {
      const conversationId = id(notification.conversationId);
      return conversationId ? `/app/chats/${conversationId}` : "/app/chats";
    }
    case "MEETING_SCHEDULED":
    case "MEETING_INVITATION": {
      const callId = id(notification.callId);
      return callId ? `/app/meetings/${callId}` : "/app/meetings";
    }
    case "TASK_ACKNOWLEDGED":
    case "TASK_ASSIGNED":
    case "TASK_COMPLETED":
    case "TASK_IGNORED":
    case "TASK_LEFT":
    case "TASK_WITHDRAWN": {
      const taskId = id(notification.taskId);
      return taskId ? `/app/mail/task/${taskId}` : "/app/tasks/allocated";
    }
    default: {
      // Compile-time: a new kind must be handled above. Run-time: a kind this
      // build has never heard of opens the app's home, not a made-up path.
      const exhaustive: never = notification.kind;
      void exhaustive;
      return "/app";
    }
  }
}

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROUTES = [
  /^\/app$/,
  /^\/app\/(channels|chats|meetings)$/,
  /^\/app\/tasks\/allocated$/,
  new RegExp(`^/app/(channels|chats|meetings)/${UUID_SOURCE}$`, "i"),
  new RegExp(`^/app/mail/task/${UUID_SOURCE}$`, "i"),
];

/**
 * True only for a path `notificationDestination` could have produced. The
 * desktop main process uses it before telling the renderer to navigate, and the
 * renderer uses it again before it touches the location: a route that arrives
 * over IPC is checked, not trusted.
 */
export function isNotificationRoute(path: unknown): path is string {
  return typeof path === "string" && ROUTES.some((route) => route.test(path));
}

/**
 * Open a notification's target from wherever the user is.
 *
 * An explicit navigation, so it always goes to the target — it is not a request
 * to go back to the previous page. When the target is already on screen the
 * entry is replaced rather than stacked, so Back is not made to walk through
 * identical pages.
 */
export function openNotificationRoute(
  navigate: (to: string, options?: { replace?: boolean }) => void,
  currentPath: string,
  target: string,
): void {
  navigate(target, { replace: currentPath === target });
}
