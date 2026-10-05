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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The fields of a notification record that decide where it leads. */
export interface NotificationTarget {
  /** A string, not a closed union: the feed carries kinds this build may not know. */
  kind: string;
  taskId?: string | null;
  channelId?: string | null;
  conversationId?: string | null;
  /** The message to land on, for the two kinds that point at one. */
  messageId?: string | null;
  callId?: string | null;
}

const id = (value: string | null | undefined): string | null => (value && UUID.test(value) ? value : null);

/** The value if it is a UUID, else null. For ids read back out of a URL or an IPC message. */
export const validUuid = (value: string | null | undefined): string | null => id(value);

/** The query parameter that carries the message a thread should scroll to and highlight. */
export const NOTIFICATION_MESSAGE_PARAM = "m";

/** `?m=<messageId>` when the id is usable, else nothing — the thread still opens. */
const messageQuery = (messageId: string | null | undefined): string => {
  const valid = id(messageId);
  return valid ? `?${NOTIFICATION_MESSAGE_PARAM}=${valid}` : "";
};

export function notificationDestination(notification: NotificationTarget): string {
  switch (notification.kind) {
    case "CHANNEL_ADDED":
    case "CHANNEL_CREATED": {
      const channelId = id(notification.channelId);
      return channelId ? `/app/channels/${channelId}` : "/app/channels";
    }
    case "CHANNEL_MESSAGE": {
      const channelId = id(notification.channelId);
      // A message id means nothing without the channel it lives in.
      return channelId ? `/app/channels/${channelId}${messageQuery(notification.messageId)}` : "/app/channels";
    }
    case "DM_MESSAGE": {
      const conversationId = id(notification.conversationId);
      return conversationId ? `/app/chats/${conversationId}${messageQuery(notification.messageId)}` : "/app/chats";
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
    default:
      // A kind this build has never heard of (a newer server wrote it) opens the
      // app's home, not a made-up path. Which kinds exist is pinned against
      // notification-svc's own list by shared/notification.kinds.test.ts.
      return "/app";
  }
}

/** The path a notification leads to, or null when it leads nowhere. A kind this build
 *  does not know falls back to "/app" above; that is "no destination" — clicking it
 *  should mark it read and leave the user where they are, not throw them to home. */
export function notificationRoute(notification: NotificationTarget): string | null {
  const path = notificationDestination(notification);
  return path !== "/app" && isNotificationRoute(path) ? path : null;
}

/** The family a notification belongs to — what its icon and grouping are drawn from. */
export type NotificationCategory = "task" | "chat" | "channel" | "meeting" | "other";

/**
 * Task → task, DM / channel message → chat, channel added / created → channel,
 * meeting scheduled / invitation (a ringing call is persisted as an invitation) →
 * meeting. Anything else is "other": shown, with a generic presentation, never dropped.
 * The kind families (TASK_, MEETING_, CHANNEL_) are matched by prefix so a sibling a
 * newer server adds lands in the right family; CHANNEL_MESSAGE is the one exception.
 */
export function notificationCategory(kind: string): NotificationCategory {
  if (kind === "DM_MESSAGE" || kind === "CHANNEL_MESSAGE") return "chat";
  if (kind.startsWith("TASK_")) return "task";
  if (kind.startsWith("CHANNEL_")) return "channel";
  if (kind.startsWith("MEETING_") || kind.startsWith("CALL_")) return "meeting";
  return "other";
}

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROUTES = [
  /^\/app$/,
  /^\/app\/(channels|chats|meetings)$/,
  /^\/app\/tasks\/allocated$/,
  new RegExp(`^/app/meetings/${UUID_SOURCE}$`, "i"),
  // Channel and chat threads may carry the message to land on.
  new RegExp(`^/app/(channels|chats)/${UUID_SOURCE}(\\?${NOTIFICATION_MESSAGE_PARAM}=${UUID_SOURCE})?$`, "i"),
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
  // The thread's own path decides "already here"; its ?m= does not.
  navigate(target, { replace: currentPath === target.split("?")[0] });
}
