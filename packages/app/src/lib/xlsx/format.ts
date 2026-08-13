/**
 * Cell formatting shared by every .xlsx export.
 *
 * Lifted verbatim out of xlsxExport.ts, where they were module-private, when the
 * activity export needed exactly the same three: the same timezone rule, the
 * same timestamp format and the same duration format. Two copies of "how a
 * duration is written" is how two spreadsheets from the same product end up
 * disagreeing about what "2h 5m" means.
 */

/** The viewer's IANA timezone (e.g. "Asia/Kolkata"), for the column headers. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

/** Format an ISO-8601 instant to the device's local date+time, or "" when absent. */
export function fmtLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Human-readable duration from seconds (e.g. "2d 3h 5m"), or "" when absent. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return "";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h && !m) parts.push(`${s}s`);
  return parts.join(" ");
}

/** Milliseconds → the same duration format. Activity is measured in ms; tasks
 *  in seconds. One formatter, so both read identically in a spreadsheet. */
export function fmtDurationMs(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return "";
  return fmtDuration(Math.round(ms / 1000));
}

/** Hours as a NUMBER, for the columns someone will sum or pivot on. A duration
 *  string is readable but not arithmetic; both are worth having. */
export function hoursOf(ms: number | null | undefined): number {
  if (!ms || ms < 0) return 0;
  return Math.round((ms / 3_600_000) * 100) / 100;
}
