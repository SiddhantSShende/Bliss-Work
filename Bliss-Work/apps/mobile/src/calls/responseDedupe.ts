import type * as Notifications from 'expo-notifications';

/**
 * A notification tap can be delivered twice: live by the response listener and
 * again by `getLastNotificationResponseAsync()` (which replays the launching
 * tap on every mount). Dedupe on the notification's OWN id, so the replay is
 * ignored but a genuinely new tap — even for the same chat or task — is not.
 * (Deduping on the destination instead silently swallowed every later tap on
 * a chat/task the user had opened from a notification once.)
 */
const seen = new Set<string>();

export function isNewResponse(r: Notifications.NotificationResponse): boolean {
  const id = `${r.notification.request.identifier}:${r.notification.date}:${r.actionIdentifier}`;
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 50) seen.delete(seen.values().next().value as string);
  return true;
}
