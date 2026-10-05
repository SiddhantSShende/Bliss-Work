import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { CallMedia } from './callController';
import { isReminderSuppressed } from './meetingReminders';
import { nativeCancelIncomingCall, nativeShowIncomingCall, onNativeCallAction, startNativeRingtone, stopNativeRingtone } from './incomingCallNative';

/**
 * Incoming-call notifications (local, via expo-notifications).
 *
 * What this covers: a call that arrives while the app process is alive —
 * foreground (the in-app ring screen handles it; no notification is posted),
 * or backgrounded/screen-off while the app's websocket is still connected.
 * The notification carries Accept / Decline actions and a tap opens the
 * app's in-app ring screen — never a browser.
 *
 * What it cannot cover on its own: a call that arrives when the OS has
 * killed/frozen the app. Nothing is running to receive the websocket frame;
 * that needs a server-sent push (FCM on Android, APNs/PushKit on iOS), and
 * the backend has no push-registration endpoint today. See CALLING.md.
 *
 * The ring itself, while the app IS alive: foreground plays the native
 * ringtone directly (`startNativeRingtone`) since there is no notification to
 * carry a sound — the in-app ring screen is the UI there, and posting one
 * too would be the duplicate banner this module exists to avoid. Backgrounded
 * Android, the call-style notification posted below carries its own looping
 * ringtone (see IncomingCallModule.show). Either way, `dismissIncomingCallNotification`
 * is the one place that always stops it, so every exit from 'ringing' —
 * answered, declined, cancelled, timed out — silences the same way.
 */

const CALL_CHANNEL = 'incoming-calls';
const MISSED_CHANNEL = 'missed-calls';
const CALL_CATEGORY = 'incoming_call';

export type CallNotificationAction = 'accept' | 'decline' | 'open';

export interface CallNotificationResponse {
  action: CallNotificationAction;
  /** 1:1 ring id, or the call id of a room/channel invite. */
  callId: string;
  kind: 'direct' | 'room';
}

let initPromise: Promise<void> | null = null;

/** Channels, action buttons and the foreground policy. Idempotent, and every
 *  caller waits for the SAME run: posting before the Android channel exists
 *  drops the notification onto a default low-importance channel (no heads-up,
 *  no ring), and a failed setup must be retried rather than remembered. */
export function initCallNotifications(): Promise<void> {
  if (!initPromise) {
    initPromise = setup().catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

async function setup(): Promise<void> {

  // While the app is open the in-app ring screen IS the notification; showing
  // a banner too would be the duplicate the user is asking not to have.
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const data = n?.request?.content?.data;
      // A meeting reminder is worth showing even with the app open — unless the
      // user is already inside that very meeting.
      if ((data as { type?: string } | undefined)?.type === 'meeting_reminder') {
        const show = !isReminderSuppressed(data);
        return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
      }
      // Chat/channel messages and tasks are worth a banner even with the app open (the user
      // may be on another screen). showMessageNotification has already skipped the thread the
      // user is actually reading; everything else in the foreground is shown by the app itself.
      const type = (data as { type?: string } | undefined)?.type;
      if (type === 'message' || type === 'task') {
        return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
      }
      const foreground = AppState.currentState === 'active';
      return {
        shouldShowBanner: !foreground,
        shouldShowList: !foreground,
        shouldPlaySound: !foreground,
        shouldSetBadge: false,
      };
    },
  });

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CALL_CHANNEL, {
      name: 'Incoming calls',
      description: 'Rings when someone calls you in BlissWork',
      importance: Notifications.AndroidImportance.MAX,
      sound: 'default',
      vibrationPattern: [0, 500, 300, 500],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      audioAttributes: {
        usage: Notifications.AndroidAudioUsage.NOTIFICATION_COMMUNICATION_REQUEST,
        contentType: Notifications.AndroidAudioContentType.SONIFICATION,
      },
    });
    await Notifications.setNotificationChannelAsync(MISSED_CHANNEL, {
      name: 'Missed calls',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  await Notifications.setNotificationCategoryAsync(CALL_CATEGORY, [
    { identifier: 'accept', buttonTitle: 'Accept', options: { opensAppToForeground: true } },
    { identifier: 'decline', buttonTitle: 'Decline', options: { opensAppToForeground: false, isDestructive: true } },
  ]);
}

/** Ask for notification permission (Android 13+/iOS). Returns whether granted. */
export async function requestCallNotificationPermission(): Promise<boolean> {
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  if (!cur.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

const idFor = (callId: string) => `call-${callId}`;

/** Post the ring. Skipped while the app is in the foreground. */
export async function showIncomingCallNotification(c: {
  callId: string;
  name: string;
  media: CallMedia;
  kind: 'direct' | 'room';
  /** Channel/meeting title, when there is one. */
  context?: string;
}): Promise<void> {
  if (AppState.currentState === 'active') {
    // Foreground: the in-app ring screen IS the incoming-call UI; a heads-up
    // banner on top of it would be the exact duplicate this function exists
    // to avoid. But nothing else plays a sound for that screen, so without
    // this the phone would ring silently while BlissWork is open.
    startNativeRingtone();
    return;
  }
  // Android: the native ring (call-style, full-screen intent) IS the incoming-call
  // notification. Posting the expo one as well would be the duplicate to avoid.
  if (nativeShowIncomingCall({ callId: c.callId, name: c.name, media: c.media, kind: c.kind, context: c.context })) return;
  await initCallNotifications();
  if (__DEV__) {
    // Without this permission (Android 13+/iOS) scheduling "succeeds" and
    // nothing is ever shown — say so instead of failing silently.
    const p = await Notifications.getPermissionsAsync().catch(() => null);
    if (!p?.granted) console.debug('[call] incoming-call notification not shown: permission not granted');
  }
  const what = c.media === 'video' ? 'video call' : 'voice call';
  await Notifications.scheduleNotificationAsync({
    identifier: idFor(c.callId),
    content: {
      title: 'BlissWork',
      subtitle: c.context,
      body: `${c.name} · Incoming ${what}`,
      categoryIdentifier: CALL_CATEGORY,
      data: { type: 'incoming_call', callId: c.callId, kind: c.kind },
      sound: 'default',
      priority: 'max',
      sticky: false,
      autoDismiss: true,
    },
    trigger: Platform.OS === 'android' ? { channelId: CALL_CHANNEL } : null,
  });
}

/** Remove the ring once it no longer matters (answered/declined/cancelled/timed out). */
export async function dismissIncomingCallNotification(callId: string): Promise<void> {
  stopNativeRingtone();
  nativeCancelIncomingCall(callId);
  try {
    await Notifications.dismissNotificationAsync(idFor(callId));
  } catch {
    /* already gone */
  }
}

export async function showMissedCallNotification(name: string, media: CallMedia): Promise<void> {
  if (AppState.currentState === 'active') return;
  await initCallNotifications();
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'BlissWork',
      body: `Missed ${media === 'video' ? 'video' : 'voice'} call from ${name}`,
      data: { type: 'missed_call' },
    },
    trigger: Platform.OS === 'android' ? { channelId: MISSED_CHANNEL } : null,
  });
}

function parse(r: Notifications.NotificationResponse | null | undefined): CallNotificationResponse | null {
  const data = r?.notification.request.content.data as { type?: string; callId?: string; kind?: string } | undefined;
  if (!r || data?.type !== 'incoming_call' || !data.callId) return null;
  const action: CallNotificationAction =
    r.actionIdentifier === 'accept' ? 'accept' : r.actionIdentifier === 'decline' ? 'decline' : 'open';
  return { action, callId: data.callId, kind: data.kind === 'room' ? 'room' : 'direct' };
}

/** Taps and action buttons on an incoming-call notification. Also delivers the
 *  response that launched the app from a killed state, if there was one. */
export function onCallNotificationResponse(cb: (r: CallNotificationResponse) => void): () => void {
  const stopNative = onNativeCallAction((e) => cb({ action: e.action, callId: e.callId, kind: e.kind === 'room' ? 'room' : 'direct' }));
  const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
    const parsed = parse(resp);
    if (parsed) cb(parsed);
  });
  void Notifications.getLastNotificationResponseAsync().then((resp) => {
    const parsed = parse(resp);
    if (parsed) cb(parsed);
  });
  return () => {
    stopNative();
    sub.remove();
  };
}
