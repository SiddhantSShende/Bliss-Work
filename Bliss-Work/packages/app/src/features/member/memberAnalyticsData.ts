import type { DayBucket } from "@taskboard/shared";
import { localDay, parseLocalDay, subtractDays } from "../../lib/dateRange";

/** Whole calendar days in an inclusive `YYYY-MM-DD` range. */
function daysInRange(from: string, to: string): number {
  const start = parseLocalDay(from);
  const end = parseLocalDay(to);
  // Round, not floor: a DST change makes one local day 23 or 25 hours long.
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

/** The window of the same length that ends the day before `from` — what the
 *  comparison line ("vs previous period") is measured against. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const length = daysInRange(from, to);
  const prevTo = subtractDays(parseLocalDay(from), 1);
  return { from: localDay(subtractDays(prevTo, length - 1)), to: localDay(prevTo) };
}

/** Whole-number % change, or null when there is nothing to compare against —
 *  a jump from 0 is "new", not "+∞%", and is never shown as a number. */
export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export interface WeekdayPoint {
  active: number;
  idle: number;
}

/**
 * Average active / idle ms for each weekday (Monday first) across the range.
 *
 * Averaged per calendar day rather than summed, so a 90-day range (13 Mondays,
 * 12 Tuesdays) does not make Monday look busier. The server only returns days
 * that have a rollup row, so the divisor is every day of that weekday in the
 * range — a day with no row counts as a day of no activity. For a 7-day range
 * each weekday occurs once, which makes the points the daily values themselves.
 */
export function weekdayAverages(days: DayBucket[], from: string, to: string): WeekdayPoint[] {
  const sums = Array.from({ length: 7 }, () => ({ active: 0, idle: 0 }));
  for (const d of days) {
    const idx = (parseLocalDay(d.day).getDay() + 6) % 7; // Sunday=0 → Monday-first
    sums[idx]!.active += d.activeMs;
    sums[idx]!.idle += d.idleMs;
  }
  const counts = new Array<number>(7).fill(0);
  const end = parseLocalDay(to);
  for (let d = parseLocalDay(from); d <= end; d = subtractDays(d, -1)) {
    counts[(d.getDay() + 6) % 7]! += 1;
  }
  return sums.map((s, i) => {
    const n = counts[i] || 1;
    return { active: s.active / n, idle: s.idle / n };
  });
}
