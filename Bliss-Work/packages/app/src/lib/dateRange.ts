/**
 * Named ranges → absolute dates, computed in the VIEWER's timezone.
 *
 * The server never interprets "last week": only the client knows where the user
 * is, and an admin in Mumbai asking for "the last 7 days" means seven of their
 * days, not seven UTC days offset by five and a half hours. The tasks export has
 * always worked this way; the activity views use the same rule so a report and a
 * chart covering "the last month" cover the same month.
 */
export type RangeKey = "7d" | "30d" | "90d" | "custom";

/** `YYYY-MM-DD` in the LOCAL timezone (not toISOString, which is UTC and would
 *  shift the date by a day for anyone west of Greenwich in the evening). */
export function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
  const from = new Date(today);
  from.setDate(from.getDate() - days);
  return { from: localDay(from), to: localDay(today) };
}
