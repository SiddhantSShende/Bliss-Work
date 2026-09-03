/**
 * Shared "Today" / "Yesterday" / calendar-date arithmetic behind
 * meetingTime.ts's and chatFormat.ts's own `dayLabel` — each keeps its own
 * public signature (a call's future-facing "Tomorrow" and weekday prefix
 * aren't meaningful for a chat/mail timestamp, which is never in the future),
 * this is only the day-difference math they were both computing separately.
 */

export function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export interface DayLabelOptions {
  /** Say "Tomorrow" for t = +1 day. Meetings can be scheduled ahead; a chat/mail
   *  timestamp never is, so callers that never see a future `t` can leave this off. */
  tomorrow?: boolean;
  /** Prefix the calendar-date fallback with the short weekday name. */
  weekday?: boolean;
}

/** "Today" / "Yesterday" (/ "Tomorrow" when asked), else a short calendar date. */
export function dayLabel(t: number, opts: DayLabelOptions = {}): string {
  const days = Math.round((startOfDay(t) - startOfDay(Date.now())) / 86_400_000);
  if (days === 0) return "Today";
  if (opts.tomorrow && days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return new Date(t).toLocaleDateString(undefined, {
    weekday: opts.weekday ? "short" : undefined,
    day: "numeric",
    month: "short",
    // Only spell out the year once it stops being obvious.
    year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}
