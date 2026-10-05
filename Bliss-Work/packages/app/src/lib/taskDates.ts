import type { DeadlineRule } from "@taskboard/shared";
import i18n from "../i18n";

/**
 * A task's assigned / deadline / missed instants as a card prints them: the
 * viewer's own local date AND time ("Oct 3, 4:00 PM"), following the in-app
 * language rather than the browser's. The year appears only once it stops being
 * obvious, like dayLabel's calendar fallback. "" for an absent or unparseable
 * value, so a caller can skip the chip instead of printing "Invalid Date".
 */
export function formatTaskInstant(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(i18n.language, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A recurring series' deadline rule in words ("6 hours after each occurrence",
 * "5:00 PM on each occurrence's date"). The rule is stored on the series, so this
 * is what a sender sees on the schedule card; each generated task shows its own
 * resolved deadline instead.
 */
export function describeDeadlineRule(rule: DeadlineRule): string {
  if (rule.kind === "RELATIVE" && rule.amount && rule.unit) {
    return i18n.t("tasks:deadline.relative", {
      amount: rule.amount,
      unit: i18n.t(`tasks:deadline.unit.${rule.unit}`, { count: rule.amount }),
    });
  }
  const [hour, minute] = (rule.time ?? "").split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return "";
  const at = new Date(2000, 0, 1, hour, minute).toLocaleTimeString(i18n.language, { hour: "numeric", minute: "2-digit" });
  return i18n.t("tasks:deadline.fixed", { time: at });
}

/** "2026-10-03" + "16:00" (both as the person picked them, local) as an ISO-8601
 *  instant WITH the local UTC offset, which is what task-svc requires of every
 *  datetime it is sent. null while either part is empty or unparseable. */
export function localDateTimeWithOffset(date: string, time: string): string | null {
  const value = new Date(`${date}T${time}`);
  if (Number.isNaN(value.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -value.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const minutes = Math.abs(offset);
  return `${date}T${time}:00${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
