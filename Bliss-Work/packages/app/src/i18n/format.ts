import { formatMs as formatMsIn } from "@taskboard/ui";
import i18n from "./index";

/**
 * Locale-aware formatting that follows the in-app language (`i18n.language`),
 * not the OS/browser locale. Read at call time, so a language switch applies to
 * the next render — same contract as the existing `toLocale*String(i18n.language)`
 * call sites.
 */

type DurationUnit = "day" | "hour" | "minute" | "second";

function unitFormatter(unit: DurationUnit): Intl.NumberFormat {
  return new Intl.NumberFormat(i18n.language, { style: "unit", unit, unitDisplay: "narrow", maximumFractionDigits: 0 });
}

/** "45m", "1h 20m", "2h" (en) · "45分" (ja) · "1 Std." — units follow the language.
 *  Under a minute reads "<1m" rather than "0m", which looks like a meeting that
 *  did not happen. Callers handle "no value" themselves. */
export function formatDurationCompact(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `<${unitFormatter("minute").format(1)}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(unitFormatter("hour").format(hours));
  if (minutes > 0) parts.push(unitFormatter("minute").format(minutes));
  return parts.join(" ");
}

/** Chart/stat duration ("45m", "1.5h"), units in the in-app language. */
export function formatMs(ms: number): string {
  return formatMsIn(ms, i18n.language);
}
