import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { isNewResponse } from './responseDedupe';
import type { CallDTO } from '@taskboard/shared';

/**
 * "Your meeting starts in 10 minutes" — as a notification the OS itself
 * delivers at the right moment (a dated local notification: AlarmManager on
 * Android, UNUserNotificationCenter on iOS), so it fires with BlissWork closed,
 * backgrounded or the phone locked. It is NOT a JS timer.
 *
 * What it is not: a server push. The backend has no reminder job and no push
 * registration, so this device schedules its own reminders for every meeting it
 * currently knows about (`GET /calls` — the calls this user is on the roster of,
 * i.e. the creator AND everyone invited). `syncMeetingReminders` is a full
 * reconcile, run whenever that list changes and whenever the app returns to the
 * foreground, so:
 *   - a new meeting gets a reminder, and an invitee's device gets theirs once it
 *     has synced (the `call.scheduled` event does that while the app is alive);
 *   - a rescheduled meeting gets a new reminder and the old one is cancelled
 *     (the id embeds the start time);
 *   - a cancelled/ended/deleted meeting has its reminder cancelled;
 *   - the same meeting + start time can only ever have ONE pending reminder
 *     (fixed identifier; scheduling it again replaces it).
 * The limit — see CALLING.md/report — is that a device that has not synced since
 * a change (app closed) cannot learn of it, so its old reminder still fires.
 */
export const REMINDER_LEAD_MS = 10 * 60_000;
export const REMINDER_CATEGORY = 'meeting_reminder';
const REMINDER_CHANNEL = 'meeting-reminders';
const ID_PREFIX = 'meeting-reminder:';
/** iOS keeps at most 64 pending local notifications in total. */
const MAX_PENDING = 48;
/** Not worth scheduling for a moment that is about to pass. */
const MIN_LEAD_MS = 5_000;

export interface PlannedReminder {
  id: string;
  callId: string;
  title: string;
  media: 'audio' | 'video';
  fireAt: number;
  startsAt: number;
}

/** Stable per (meeting, reminder type, start time): the dedupe key AND what
 *  makes a time change invalidate the old reminder. */
export function reminderId(callId: string, startsAt: number): string {
  return `${ID_PREFIX}${callId}:10m:${startsAt}`;
}

/** Which reminders should exist right now. Only meetings still SCHEDULED, with a
 *  real start time, whose 10-minute mark is still ahead. */
export function planReminders(calls: readonly CallDTO[], now: number): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  for (const c of calls) {
    if (c.status !== 'SCHEDULED' || !c.scheduledAt) continue;
    const startsAt = Date.parse(c.scheduledAt);
    if (!Number.isFinite(startsAt)) continue;
    const fireAt = startsAt - REMINDER_LEAD_MS;
    if (fireAt - now < MIN_LEAD_MS) continue;
    out.push({ id: reminderId(c.id, startsAt), callId: c.id, title: c.title, media: c.media, fireAt, startsAt });
  }
  return out.sort((a, b) => a.fireAt - b.fireAt).slice(0, MAX_PENDING);
}

/** Cancel every pending reminder that is no longer wanted; schedule every wanted
 *  one that is missing. Unrelated notifications are never touched. */
export function diffReminders(planned: readonly PlannedReminder[], pendingIds: readonly string[]) {
  const wanted = new Set(planned.map((p) => p.id));
  const have = new Set(pendingIds);
  return {
    toCancel: pendingIds.filter((id) => id.startsWith(ID_PREFIX) && !wanted.has(id)),
    toSchedule: planned.filter((p) => !have.has(p.id)),
  };
}

export function reminderBody(title: string): string {
  return `${title.trim() || 'Your meeting'} starts in 10 minutes.`;
}

// ── suppression while already in that meeting ────────────────────────────────

let inMeeting: (callId: string) => boolean = () => false;

/** The call layer tells us whether the user is already in a given meeting, so a
 *  reminder that fires while the app is alive can be skipped. (A reminder the OS
 *  delivers to a closed app cannot be inspected — nothing is running.) */
export function setInMeetingCheck(fn: (callId: string) => boolean): void {
  inMeeting = fn;
}

export function isReminderSuppressed(data: unknown): boolean {
  const d = data as { type?: string; callId?: string } | undefined;
  return d?.type === 'meeting_reminder' && !!d.callId && inMeeting(d.callId);
}

// ── scheduling ───────────────────────────────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();
let channelReady: Promise<void> | null = null;

function ensureReminderSetup(): Promise<void> {
  channelReady ??= (async () => {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL, {
        name: 'Meeting reminders',
        description: 'Tells you a meeting starts in 10 minutes',
        importance: Notifications.AndroidImportance.HIGH,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }
    await Notifications.setNotificationCategoryAsync(REMINDER_CATEGORY, [
      { identifier: 'join', buttonTitle: 'Join', options: { opensAppToForeground: true } },
    ]);
  })().catch((e) => {
    channelReady = null;
    throw e;
  });
  return channelReady;
}

export interface SyncResult {
  scheduled: number;
  cancelled: number;
  /** False when notifications are not allowed: nothing can be shown, so nothing is scheduled. */
  permitted: boolean;
}

/**
 * Make the device's pending reminders match `calls`. Serialised: two overlapping
 * syncs (an invalidation and a foreground refresh) run one after the other, so
 * they cannot both decide a reminder is missing and schedule it twice.
 */
export function syncMeetingReminders(calls: readonly CallDTO[], now = Date.now()): Promise<SyncResult> {
  const run = chain.then(async (): Promise<SyncResult> => {
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) return { scheduled: 0, cancelled: 0, permitted: false };
    await ensureReminderSetup();
    const pending = await Notifications.getAllScheduledNotificationsAsync();
    const { toCancel, toSchedule } = diffReminders(
      planReminders(calls, now),
      pending.map((p) => p.identifier),
    );
    for (const id of toCancel) await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
    for (const r of toSchedule) {
      await Notifications.scheduleNotificationAsync({
        identifier: r.id,
        content: {
          title: 'Upcoming Meeting',
          subtitle: new Date(r.startsAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
          body: reminderBody(r.title),
          categoryIdentifier: REMINDER_CATEGORY,
          data: { type: 'meeting_reminder', callId: r.callId, media: r.media, title: r.title },
          sound: 'default',
          priority: 'high',
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(r.fireAt),
          ...(Platform.OS === 'android' ? { channelId: REMINDER_CHANNEL } : {}),
        },
      });
    }
    return { scheduled: toSchedule.length, cancelled: toCancel.length, permitted: true };
  });
  chain = run.catch(() => undefined);
  return run;
}

/** Sign-out: another account must not inherit this one's reminders. */
export function cancelAllMeetingReminders(): Promise<void> {
  const run = chain.then(async () => {
    const pending = await Notifications.getAllScheduledNotificationsAsync();
    for (const p of pending) {
      if (p.identifier.startsWith(ID_PREFIX)) await Notifications.cancelScheduledNotificationAsync(p.identifier).catch(() => undefined);
    }
  });
  chain = run.catch(() => undefined);
  return run.catch(() => undefined);
}

export interface MeetingReminderResponse {
  callId: string;
}

/** Tap on a reminder or its Join button (also delivers the one that launched the app). */
export function onMeetingReminderResponse(cb: (r: MeetingReminderResponse) => void): () => void {
  const parse = (resp: Notifications.NotificationResponse | null | undefined) => {
    const d = resp?.notification.request.content.data as { type?: string; callId?: string } | undefined;
    // A tap and the Join button both open the meeting (this category has no dismiss action).
    if (resp && d?.type === 'meeting_reminder' && d.callId && isNewResponse(resp)) cb({ callId: d.callId });
  };
  const sub = Notifications.addNotificationResponseReceivedListener(parse);
  void Notifications.getLastNotificationResponseAsync().then(parse);
  return () => sub.remove();
}
