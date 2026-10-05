import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { isNewResponse } from './responseDedupe';

/**
 * "New Mail" — local, scheduled the instant MailDelivered arrives over the
 * already-open WebSocket. Same "alive but not foreground" reach and the
 * identical closed-app limit as messageNotifications.ts/taskNotifications.ts
 * (no push-registration endpoint on the backend, see CALLING.md).
 *
 * MailDelivered itself is signal-only (mailId + senderId only — see its own
 * doc in packages/shared/src/types/events.ts: the gateway deliberately never
 * puts mail contents in the replay outbox), so the caller must fetch the real
 * mail (api.mail(mailId)) before calling this — never a placeholder body.
 */

const MAIL_CHANNEL = 'mail';
const MAIL_CATEGORY = 'new_mail';

let initPromise: Promise<void> | null = null;

function initMailNotifications(): Promise<void> {
  if (!initPromise) {
    initPromise = setup().catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

async function setup(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(MAIL_CHANNEL, {
      name: 'Mail',
      description: 'New mail delivered to your BlissWork inbox',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
    });
  }
  await Notifications.setNotificationCategoryAsync(MAIL_CATEGORY, []);
}

export interface DeliveredMail {
  mailId: string;
  from: string;
  subject: string;
  /** Real bodyText from api.mail(), truncated by the caller — never invented. Optional: older call sites still work with just a subject line. */
  preview?: string;
}

/** Skipped while BlissWork is in the foreground — the inbox refreshes live
 *  from the same WS event regardless (see useWsBridge.ts). */
export async function showMailNotification(m: DeliveredMail): Promise<void> {
  if (AppState.currentState === 'active') return;
  await initMailNotifications();
  await Notifications.scheduleNotificationAsync({
    // Reusing the mail id as the notification's own identifier means a
    // duplicate MailDelivered redelivery replaces rather than doubles it.
    identifier: `mail-${m.mailId}`,
    content: {
      title: 'BlissWork',
      subtitle: 'New Mail',
      body: `${m.from}\n${m.subject}${m.preview ? ` — ${m.preview}` : ''}`,
      categoryIdentifier: MAIL_CATEGORY,
      data: { type: 'mail', mailId: m.mailId },
      sound: 'default',
    },
    trigger: Platform.OS === 'android' ? { channelId: MAIL_CHANNEL } : null,
  });
}

/** Taps on a mail notification, including one that launched the app from a
 *  killed state — see messageNotifications.ts/taskNotifications.ts for why
 *  both the live listener and getLastNotificationResponseAsync are needed. */
export function onMailNotificationResponse(cb: (mailId: string) => void): () => void {
  const parse = (r: Notifications.NotificationResponse | null | undefined) => {
    const data = r?.notification.request.content.data as { type?: string; mailId?: string } | undefined;
    return r && data?.type === 'mail' && data.mailId && isNewResponse(r) ? data.mailId : null;
  };
  const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
    const mailId = parse(resp);
    if (mailId) cb(mailId);
  });
  void Notifications.getLastNotificationResponseAsync().then((resp) => {
    const mailId = parse(resp);
    if (mailId) cb(mailId);
  });
  return () => sub.remove();
}
