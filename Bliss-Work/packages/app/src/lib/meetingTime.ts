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
import { dayLabel as _dayLabel, startOfDay } from "./dayLabel";
import { groupConsecutiveByLabel } from "./groupConsecutive";
import type { TFunction } from "i18next";
import i18n from "../i18n";

export { startOfDay };

/** The moment a call belongs at in the list: when it is meant to happen, or —
 *  for a "meet now" that was never scheduled — when it actually did. */
export function whenOf(c: CallDTO): number {
  const iso = c.scheduledAt || c.startedAt || c.endedAt || c.createdAt;
  return new Date(iso).getTime();
}

/** "Today" / "Tomorrow" / "Yesterday", else a short calendar date. Relative to
 *  the viewer's own day boundary, which is what a person means by "today". A
 *  call can be scheduled ahead, so unlike chatFormat's dayLabel this always
 *  offers "Tomorrow" and a weekday-prefixed fallback. */
export function dayLabel(t: number): string {
  return _dayLabel(t, { tomorrow: true, weekday: true });
}

export function timeLabel(t: number): string {
  return new Date(t).toLocaleTimeString(i18n.language, { hour: "numeric", minute: "2-digit" });
}

/** "45 min", "1 hour", "1 hour 30 min", "2 days 3 hours" — how long a meeting runs. Empty
 *  for a span that is not positive, so a half-filled form never prints "0 min". */
export function durationLabel(t: TFunction, startMs: number, endMs: number): string {
  const total = Math.round((endMs - startMs) / 60_000);
  if (!(total > 0)) return "";
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  return [
    days ? t("newMeeting.preview.duration.days", { count: days }) : "",
    hours ? t("newMeeting.preview.duration.hours", { count: hours }) : "",
    minutes ? t("newMeeting.preview.duration.minutes", { count: minutes }) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Consecutive runs of the same day, in the order the caller sorted them. */
export function groupByDay(calls: CallDTO[]): { label: string; items: CallDTO[] }[] {
  return groupConsecutiveByLabel(calls, (c) => dayLabel(whenOf(c)));
}
