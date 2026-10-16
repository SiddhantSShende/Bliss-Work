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

export interface ActivityBucket {
  /** First day of the bucket, `YYYY-MM-DD` — unique, used as the React key. */
  key: string;
  /** Last day of the bucket (inclusive); equal to `key` for a one-day bucket. */
  end: string;
  active: number;
  idle: number;
}

/**
 * Buckets `days` into contiguous, gap-filled time slices covering the whole
 * [from, to] range — one bucket per day for 7d/30d, one per week for 90d, so
 * a 90-day range draws ~13 bars instead of 90 unreadably thin ones.
 *
 * Gaps (a day the server never rolled up) become zero-filled buckets rather
 * than being skipped, so the x-axis stays one tick per real calendar period.
 */
export function activityBuckets(days: DayBucket[], from: string, to: string): ActivityBucket[] {
  const span = daysInRange(from, to);
  const bucketDays = span > 35 ? 7 : 1;
  const byDay = new Map(days.map((d) => [d.day, d]));

  const buckets: ActivityBucket[] = [];
  let cursor = parseLocalDay(from);
  const end = parseLocalDay(to);
  while (cursor <= end) {
    const bucketStart = localDay(cursor);
    let active = 0;
    let idle = 0;
    let last = bucketStart;
    for (let i = 0; i < bucketDays; i++) {
      const day = localDay(cursor);
      if (day > to) break;
      const row = byDay.get(day);
      if (row) {
        active += row.activeMs;
        idle += row.idleMs;
      }
      last = day;
      cursor = subtractDays(cursor, -1);
    }
    buckets.push({ key: bucketStart, end: last, active, idle });
  }
  return buckets;
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
