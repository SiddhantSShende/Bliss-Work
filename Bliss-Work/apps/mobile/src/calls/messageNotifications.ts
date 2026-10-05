import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { listPreview } from '@taskboard/app/chatEnvelope';
import { isNewResponse } from './responseDedupe';

/**
 * "New message" notifications — local, scheduled the instant the message
 * arrives over the already-open WebSocket (see useWsBridge.ts), same
 * mechanism as the meeting reminders and the incoming-call ring's expo
 * fallback. Real sender/text from the WS event every time; nothing here is
 * hardcoded.
 *
 * What this covers: a message that arrives while the app process is alive —
 * foreground on a DIFFERENT screen than that conversation, or backgrounded
 * with the WebSocket still connected.
 *
 * What it cannot cover on its own: a message that arrives after the OS has
 * killed/frozen the app. Nothing is running to receive the WebSocket frame;
 * that needs a server-sent push (FCM on Android, APNs on iOS), and the
 * backend has no push-registration endpoint today — see CALLING.md, which
 * documents the identical limit for calls.
 */

const MESSAGE_CHANNEL = 'messages';
const MESSAGE_CATEGORY = 'chat_message';

export type ThreadRef = { kind: 'chat'; id: string } | { kind: 'channel'; id: string };

function sameThread(a: ThreadRef, b: ThreadRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

// ── "is the user already looking at this" ───────────────────────────────────
// Set by ChatConversationScreen/ChannelConversationScreen via useFocusEffect
// (see those files) — screen-navigation focus, not app foreground/background;
// combined with AppState below so a screen left focused while the app is
// merely backgrounded does not suppress the notification.
let focused: ThreadRef | null = null;

export function setThreadFocused(ref: ThreadRef): void {
  focused = ref;
}

export function clearThreadFocused(ref: ThreadRef): void {
  if (focused && sameThread(focused, ref)) focused = null;
}

function isAlreadyViewing(ref: ThreadRef): boolean {
  return AppState.currentState === 'active' && !!focused && sameThread(focused, ref);
}

let initPromise: Promise<void> | null = null;

/** Idempotent, like initCallNotifications — every caller awaits the same run. */
function initMessageNotifications(): Promise<void> {
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
    await Notifications.setNotificationChannelAsync(MESSAGE_CHANNEL, {
      name: 'Messages',
      description: 'New chat and channel messages in BlissWork',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250],
    });
  }
  await Notifications.setNotificationCategoryAsync(MESSAGE_CATEGORY, []);
}

export interface IncomingMessage {
  ref: ThreadRef;
  /** Real display name from the WS event / query cache — never hardcoded. */
  senderName: string;
  /** The message's RAW body — for an image/file/location message this is the
   *  encoded envelope (readable prefix + a control char + JSON), never shown
   *  as-is; `showMessageNotification` runs it through the same `listPreview`
   *  the Chats/Channels list rows use, so a photo reads "Image sent" here
   *  too, never the raw prefix+JSON. */
  body: string;
  /** Channel messages only: shown as "#name" above the sender line. */
  channelName?: string;
  /** What tapping the notification navigates to — the real ids the existing
   *  ChatConversation/ChannelConversation screens require. */
  nav:
    | { kind: 'chat'; conversationId: string; peerId: string; peerName: string }
    | { kind: 'channel'; channelId: string; channelName: string };
}

/** Post a message notification, unless the user is already looking at that
 *  exact thread right now (foreground + that screen focused). */
export async function showMessageNotification(m: IncomingMessage): Promise<void> {
  if (isAlreadyViewing(m.ref)) return;
  await initMessageNotifications();
  // Always incoming (the caller never notifies for the viewer's own message),
  // so isOwn is always false here.
  const preview = listPreview(m.body, false);
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'BlissWork',
      subtitle: m.channelName ? `#${m.channelName}` : undefined,
      body: `${m.senderName}: ${preview}`,
      categoryIdentifier: MESSAGE_CATEGORY,
      data: { type: 'message', nav: m.nav },
      sound: 'default',
    },
    trigger: Platform.OS === 'android' ? { channelId: MESSAGE_CHANNEL } : null,
  });
}

/** Taps on a message notification, including one that launched the app from
 *  a killed state. */
export function onMessageNotificationResponse(cb: (nav: IncomingMessage['nav']) => void): () => void {
  const parse = (r: Notifications.NotificationResponse | null | undefined) => {
    const data = r?.notification.request.content.data as { type?: string; nav?: IncomingMessage['nav'] } | undefined;
    return r && data?.type === 'message' && data.nav && isNewResponse(r) ? data.nav : null;
  };
  const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
    const nav = parse(resp);
    if (nav) cb(nav);
  });
  void Notifications.getLastNotificationResponseAsync().then((resp) => {
    const nav = parse(resp);
    if (nav) cb(nav);
  });
  return () => sub.remove();
}
