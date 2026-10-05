/**
 * The decision logic behind the New Meeting form, kept free of React so it can
 * be tested. It mirrors web's NewMeetingDialog.tsx and the server's own rules
 * (calls.go `scheduleGraceWindow`), so mobile never rejects what the server
 * accepts, or the reverse.
 *
 * Everything works on real `Date` values, never on formatted strings: the
 * picker shows "03:16 PM" but the comparison is between instants, which is what
 * keeps 03:16 PM from ever being read as 03:16 AM.
 */

/** Slack for "now": the seconds between opening the form and tapping submit,
 *  and ordinary clock skew. Also the Start Now / Schedule boundary. */
export const GRACE_MS = 60_000;

/** The server's default run time for a scheduled meeting (defaultCallMinutes). */
export const DEFAULT_MEETING_MINUTES = 60;

export type StartKind = 'now' | 'future' | 'past';

/** `now`: within the grace window either side (Start Now); `future`: clearly
 *  ahead (Schedule); `past`: already gone (rejected). */
export function classifyStart(startAt: Date, now: number): StartKind {
  const delta = startAt.getTime() - now;
  if (delta > GRACE_MS) return 'future';
  if (delta < -GRACE_MS) return 'past';
  return 'now';
}

export interface MeetingErrors {
  title?: string;
  start?: string;
  end?: string;
}

export function validateMeeting(input: { title: string; startAt: Date; endAt: Date; now: number }): MeetingErrors {
  const errors: MeetingErrors = {};
  if (!input.title.trim()) errors.title = 'Meeting title is required.';
  if (classifyStart(input.startAt, input.now) === 'past') errors.start = 'Start time has already passed.';
  // Strictly after: equal is a zero-length meeting. A meeting that crosses
  // midnight is simply an end date one day later, which this allows.
  if (input.endAt.getTime() <= input.startAt.getTime()) errors.end = 'End time must be after start time.';
  return errors;
}

export function durationMinutes(startAt: Date, endAt: Date): number {
  return Math.round((endAt.getTime() - startAt.getTime()) / 60_000);
}

/** Drop seconds/millis so "now" reads as the minute on the clock. */
export function floorToMinute(ms: number): Date {
  const d = new Date(ms);
  d.setSeconds(0, 0);
  return d;
}

// ── 12-hour clock ────────────────────────────────────────────────────────────

export interface Clock12 {
  /** 1–12 */
  hour: number;
  /** 0–59 */
  minute: number;
  pm: boolean;
}

export function toClock12(d: Date): Clock12 {
  const h = d.getHours();
  return { hour: h % 12 === 0 ? 12 : h % 12, minute: d.getMinutes(), pm: h >= 12 };
}

/** 12 AM is hour 0, 12 PM is hour 12 — the two places an AM/PM bug lives. */
export function to24Hour(hour12: number, pm: boolean): number {
  return (hour12 % 12) + (pm ? 12 : 0);
}

/** Same calendar day as `d`, at the given 12-hour time. */
export function withClock12(d: Date, c: Clock12): Date {
  const out = new Date(d);
  out.setHours(to24Hour(c.hour, c.pm), c.minute, 0, 0);
  return out;
}

/** Same time of day as `d`, on the given calendar day. */
export function withCalendarDay(d: Date, year: number, month: number, day: number): Date {
  const out = new Date(d);
  // Set all three together so Jan 31 -> "Feb" cannot roll into March.
  out.setFullYear(year, month, day);
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "28-09-2026", the format the reference design uses. */
export function formatDateField(d: Date): string {
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/** "03:16 PM" */
export function formatTimeField(d: Date): string {
  const c = toClock12(d);
  return `${pad(c.hour)}:${pad(c.minute)} ${c.pm ? 'PM' : 'AM'}`;
}

/** "29 Sep 2026" */
export function formatDateLong(d: Date): string {
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Starts in 8 minutes" / "in 2 hours" / "in 3 days"; null once it has started. */
export function startsInLabel(startAt: Date, now: number): string | null {
  const mins = Math.ceil((startAt.getTime() - now) / 60_000);
  if (mins <= 0) return null;
  if (mins < 60) return `Starts in ${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Starts in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `Starts in ${days} day${days === 1 ? '' : 's'}`;
}

// ── invitees + the live preview ──────────────────────────────────────────────

/** The server's cap on an up-front meeting roster (maxMeetingInvitees). */
export const MAX_MEETING_INVITEES = 200;

/** Ids from every list, in order, each once. */
export function mergeInviteeIds(...lists: readonly (readonly string[])[]): string[] {
  return Array.from(new Set(lists.flat()));
}

function nameList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(', ');
  return `${names[0]}, ${names[1]} +${names.length - 2} more`;
}

/** "No one invited yet" / "Priya, Sam +3 more" / "Priya · #general, #design". */
export function inviteesSummary(people: readonly string[], channels: readonly string[]): string {
  if (people.length === 0 && channels.length === 0) return 'No one invited yet';
  const chans = channels.length ? nameList(channels.map((c) => `#${c}`)) : '';
  return [people.length ? nameList(people) : '', chans].filter(Boolean).join(' · ');
}

const sameCalendarDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "Today", "Tomorrow", else "Fri, 3 Oct" (the year only when it is not this year's). */
export function relativeDayLabel(d: Date, now: number): string {
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(today.getDate() + 1);
  if (sameCalendarDay(d, today)) return 'Today';
  if (sameCalendarDay(d, tomorrow)) return 'Tomorrow';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' as const } : {}),
  });
}

/** "Today · 12:07 PM – 1:07 PM", or across days "Today 11:30 PM – Tomorrow 12:30 AM". */
export function describeWhen(startAt: Date, endAt: Date, now: number, clock: (d: Date) => string): string {
  if (sameCalendarDay(startAt, endAt)) return `${relativeDayLabel(startAt, now)} · ${clock(startAt)} – ${clock(endAt)}`;
  return `${relativeDayLabel(startAt, now)} ${clock(startAt)} – ${relativeDayLabel(endAt, now)} ${clock(endAt)}`;
}
