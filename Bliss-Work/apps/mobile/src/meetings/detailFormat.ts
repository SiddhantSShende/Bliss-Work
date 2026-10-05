/**
 * Small pure formatters for the Meeting Details screen.
 */

type Status = 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED';

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "Today, 10:00 AM – 10:30 AM", "Tomorrow, …", "Wed, Sep 30, …". */
export function whenLabel(startIso: string | null | undefined, endIso: string | null | undefined, now: Date = new Date()): string {
  if (!startIso) return 'No time set';
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return 'No time set';
  const dayDiff = Math.round((startOfDay(start) - startOfDay(now)) / 86_400_000);
  const day =
    dayDiff === 0
      ? 'Today'
      : dayDiff === 1
        ? 'Tomorrow'
        : dayDiff === -1
          ? 'Yesterday'
          : start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const end = endIso ? new Date(endIso) : null;
  const range = end && !Number.isNaN(end.getTime()) ? `${clock(start)} – ${clock(end)}` : clock(start);
  return `${day}, ${range}`;
}

/** The first 8 hex digits of the meeting's id, upper-cased: a short, real
 *  identifier a person can read out (it is the start of the actual id). */
export function shortMeetingId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

export const STATUS_TEXT: Record<Status, string> = { SCHEDULED: 'Scheduled', LIVE: 'Live now', ENDED: 'Ended', CANCELLED: 'Cancelled' };

/** Which meetings can still be joined / started / managed. */
export function isOpen(status: Status): boolean {
  return status === 'SCHEDULED' || status === 'LIVE';
}

export function participantsLabel(n: number): string {
  return `${n} ${n === 1 ? 'participant' : 'participants'}`;
}
