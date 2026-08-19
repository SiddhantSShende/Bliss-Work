/**
 * When a call happens, and how to say it.
 *
 * Extracted from the Meetings page once the card needed the same answers the
 * page already had: the page groups rows into days, and each card prints the
 * day and the time inside itself. Two implementations of "which timestamp does
 * this call actually happen at" would have drifted the first time a "meet now"
 * call — one with no scheduledAt at all — turned up in only one of them.
 */
import type { CallDTO } from "@taskboard/shared";

/** The moment a call belongs at in the list: when it is meant to happen, or —
 *  for a "meet now" that was never scheduled — when it actually did. */
export function whenOf(c: CallDTO): number {
  const iso = c.scheduledAt || c.startedAt || c.endedAt || c.createdAt;
  return new Date(iso).getTime();
}

export function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today" / "Tomorrow" / "Yesterday", else a short calendar date. Relative to
 *  the viewer's own day boundary, which is what a person means by "today". */
export function dayLabel(t: number): string {
  const days = Math.round((startOfDay(t) - startOfDay(Date.now())) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return new Date(t).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    // Only spell out the year once it stops being obvious.
    year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

export function timeLabel(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * The one line a card prints for "when": the day, the start time, and — only
 * once a call has actually finished — the time it ended.
 *
 * The end is deliberately absent while a call is live: `endedAt` is not set yet,
 * and a scheduled call carries no duration anywhere in the API, so anything
 * printed there would be invented.
 */
export function whenLabel(c: CallDTO): string {
  const start = whenOf(c);
  const line = `${dayLabel(start)}, ${timeLabel(start)}`;
  if (!c.endedAt) return line;
  const end = new Date(c.endedAt).getTime();
  // A call that ran past midnight ends on a different day than it started, and
  // "9:40 PM – 12:10 AM" reads as a typo unless the day comes with it.
  const sameDay = startOfDay(end) === startOfDay(start);
  return `${line} – ${sameDay ? timeLabel(end) : `${dayLabel(end)}, ${timeLabel(end)}`}`;
}

/** Consecutive runs of the same day, in the order the caller sorted them. */
export function groupByDay(calls: CallDTO[]): { label: string; items: CallDTO[] }[] {
  const groups: { label: string; items: CallDTO[] }[] = [];
  for (const c of calls) {
    const label = dayLabel(whenOf(c));
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(c);
    else groups.push({ label, items: [c] });
  }
  return groups;
}
