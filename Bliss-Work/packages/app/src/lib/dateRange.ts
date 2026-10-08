/**
 * Named ranges → absolute dates, computed in the VIEWER's timezone.
 *
 * The server never interprets "last week": only the client knows where the user
 * is, and an admin in Mumbai asking for "the last 7 days" means seven of their
 * days, not seven UTC days offset by five and a half hours. The tasks export has
 * always worked this way; the activity views use the same rule so a report and a
 * chart covering "the last month" cover the same month.
 */
import i18n from "../i18n";

export type RangeKey = "7d" | "30d" | "90d" | "custom";

/** The 3 fixed windows every activity view offers, before any `custom` option
 *  a particular screen adds on top. Shared so "Last 30 days" reads the same
 *  word-for-word everywhere it appears. A function, not a constant: the labels
 *  follow the in-app language at call time. */
export function activityRanges(): ReadonlyArray<{ key: RangeKey; label: string }> {
  return [
    { key: "7d", label: i18n.t("common:activityRange.last7") },
    { key: "30d", label: i18n.t("common:activityRange.last30") },
    { key: "90d", label: i18n.t("common:activityRange.last90") },
  ];
}

/** `YYYY-MM-DD` in the LOCAL timezone (not toISOString, which is UTC and would
 *  shift the date by a day for anyone west of Greenwich in the evening). */
export function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Subtract N whole days from a date via `Date#setDate`, in local time — not
 * by subtracting `days * 86_400_000` milliseconds, which silently drifts by
 * an hour across a DST transition (a local calendar day isn't always exactly
 * 24h). Every fixed-day named range (7d/30d/90d/week) is this same
 * computation; it lives here once so it can't drift between screens.
 */
export function subtractDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() - days);
  return result;
}

/**
 * Subtract whole months from a date without `Date#setMonth`'s day-rollover:
 * called on a month-end date, `setMonth`/`setFullYear` can overflow into the
 * following month when the target month is shorter (e.g. May 31 minus one
 * month naively lands on May 1, not April 30 — April has only 30 days).
 * Clamp the day to the target month's last valid day instead.
 */
export function subtractMonthsClamped(date: Date, months: number): Date {
  const originalDay = date.getDate();
  const result = new Date(date);
  result.setDate(1); // park on a day that exists in every month while the month shifts
  result.setMonth(result.getMonth() - months);
  const daysInTargetMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(originalDay, daysInTargetMonth));
  return result;
}

/**
 * The inverse of `localDay()`: turn a server-reported `YYYY-MM-DD` day bucket
 * back into a Date, anchored to LOCAL midnight rather than UTC midnight.
 *
 * `new Date("YYYY-MM-DD")` parses as UTC midnight, so formatting it with
 * `toLocaleDateString()` in a timezone behind UTC — anywhere in the Americas,
 * in the evening — renders the day BEFORE the one the server actually meant.
 * Activity charts bucket by local day (see `computeRange`/`localDay` above),
 * so the label has to be parsed the same way or it disagrees with its own data.
 */
export function parseLocalDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/**
 * Inclusive local-date bounds for a named range.
 *
 * `custom` returns whatever the caller passed; every other key ends today so a
 * dashboard opened at 09:00 includes the morning already worked.
 */
export function computeRange(
  range: RangeKey,
  custom?: { from?: string; to?: string },
): { from: string; to: string } {
  const today = new Date();
  if (range === "custom") {
    return {
      from: custom?.from || localDay(new Date(today.getTime() - 29 * 86_400_000)),
      to: custom?.to || localDay(today),
    };
  }
  const days = range === "7d" ? 6 : range === "30d" ? 29 : 89;
  return { from: localDay(subtractDays(today, days)), to: localDay(today) };
}
