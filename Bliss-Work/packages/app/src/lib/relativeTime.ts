/**
 * "12m ago", "3h ago", "yesterday", "4d ago".
 *
 * Shared by the members list and the member detail pane, which both answer
 * "when was this person last here" and must not answer it differently.
 *
 * Deliberately coarse: the point is recency, not a timestamp. A caller that
 * needs the exact moment should render the ISO value in a `title` instead.
 *
 * Localized via the global i18next instance (i18n.t), same as dayLabel.ts —
 * a plain function shared by several components, not a hook, so every
 * caller's signature stays unchanged while still following the in-app
 * selected locale.
 */
import i18n from "../i18n";

export function relativeTime(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return i18n.t("common:relativeTime.justNow");
  if (mins < 60) return i18n.t("common:relativeTime.minutesAgo", { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return i18n.t("common:relativeTime.hoursAgo", { count: hours });
  const days = Math.round(hours / 24);
  return days === 1 ? i18n.t("common:date.yesterday") : i18n.t("common:relativeTime.daysAgo", { count: days });
}
