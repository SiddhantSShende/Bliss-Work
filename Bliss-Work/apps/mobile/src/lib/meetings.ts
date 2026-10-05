import type { CallDTO } from '@taskboard/shared';

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Move by whole months, clamping the day so Jan 31 + 1 month is Feb 28/29
 *  rather than spilling into March. */
export function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), lastDay));
}

/** The Sunday on/before the 1st of `d`'s month: first cell of a 6-week grid. */
export function monthGridStart(d: Date): Date {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  return addDays(first, -first.getDay());
}

/** Sunday-start week containing `d`. */
export function weekStart(d: Date): Date {
  return addDays(startOfDay(d), -d.getDay());
}

/** A stable per-day key in the viewer's local time zone. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** When the meeting is/was on the calendar: the plan if there is one, else
 *  when it actually opened ("meet now" calls have no `scheduledAt`). */
export function meetingStart(c: CallDTO): Date {
  return new Date(c.scheduledAt ?? c.startedAt ?? c.createdAt);
}

/** When it ends (or ended). Null when the meeting named no duration and is
 *  still open-ended — those end when the last person leaves. */
export function meetingEnd(c: CallDTO): Date | null {
  const iso = c.endedAt ?? c.endsAt;
  return iso ? new Date(iso) : null;
}

export function isPast(c: CallDTO, now = new Date()): boolean {
  if (c.status === 'ENDED' || c.status === 'CANCELLED') return true;
  if (c.status === 'LIVE') return false;
  const end = meetingEnd(c);
  return end ? end.getTime() < now.getTime() : false;
}

export function formatClock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatTimeRange(c: CallDTO): string {
  const start = meetingStart(c);
  const end = meetingEnd(c);
  return end ? `${formatClock(start)} - ${formatClock(end)}` : formatClock(start);
}

/** "30 min", "1 hr", "1 hr 30 min"; null when the length is unknown. */
export function formatDuration(c: CallDTO): string | null {
  const end = meetingEnd(c);
  if (!end) return null;
  const from = c.startedAt && c.endedAt ? new Date(c.startedAt) : meetingStart(c);
  const mins = Math.round((end.getTime() - from.getTime()) / 60_000);
  if (!Number.isFinite(mins) || mins <= 0) return null;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** BlissWork calls carry no third-party provider (there is no Zoom/Teams
 *  integration) — the platform line describes the call itself. */
export function meetingPlatform(c: CallDTO): string {
  const media = c.media === 'audio' ? 'Audio call' : 'Video call';
  if (c.kind === 'CHANNEL') return `Channel ${media.toLowerCase()}`;
  return media;
}

export function participantCount(c: CallDTO): number {
  return c.participants.length;
}

/** Everything the search box matches on, lower-cased once per meeting. */
export function searchHaystack(c: CallDTO): string {
  return [
    c.title,
    meetingPlatform(c),
    c.status,
    ...c.participants.map((p) => p.username),
  ]
    .join(' ')
    .toLowerCase();
}

export function sortByStart(list: CallDTO[], dir: 'asc' | 'desc' = 'asc'): CallDTO[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => sign * (meetingStart(a).getTime() - meetingStart(b).getTime()));
}
