/**
 * The "Repeat" half of the meeting form: its state, its rules and its wording.
 *
 * Pure, so it is testable without rendering. The server enforces every one of
 * these rules again (messaging-svc internal/recurrence) — this is the same rule
 * stated where the user can act on it, not a substitute for it.
 *
 * ── Weekday numbering ────────────────────────────────────────────────────────
 * 0 = Monday … 6 = Sunday, the API's and task-svc's convention. `Date#getDay()`
 * has Sunday at 0, so every conversion goes through `weekdayIndex` — passing a
 * getDay() value straight through would put every weekly meeting on the wrong
 * day, and would do it silently.
 */
import type { TFunction } from "i18next";
import type {
  MeetingRecurrenceInput,
  RecurrenceDTO,
  RecurrenceEndCondition,
  RecurrenceFrequency,
} from "@taskboard/shared";
import i18n from "../i18n";

/** The bounds the server enforces. */
export const MAX_INTERVAL = 99;
export const MAX_OCCURRENCES = 999;

export type RepeatKind = "NONE" | RecurrenceFrequency;

export interface RecurrenceForm {
  repeat: RepeatKind;
  /** Text, not a number: a field the user has cleared to retype must be able to
   *  BE empty rather than snapping back to 1. */
  interval: string;
  /** null = "the weekday of the start date", which follows the date until the
   *  user picks days themselves — see effectiveWeekdays. */
  weekdays: number[] | null;
  endCondition: RecurrenceEndCondition;
  /** YYYY-MM-DD, local. */
  endDate: string;
  occurrenceCount: string;
}

export function emptyRecurrence(): RecurrenceForm {
  return {
    repeat: "NONE",
    interval: "1",
    weekdays: null,
    endCondition: "NO_END",
    endDate: "",
    occurrenceCount: "10",
  };
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** The weekday of a "YYYY-MM-DD" date, or null while the date is empty/invalid. */
export function weekdayOfDate(date: string): number | null {
  if (!date) return null;
  const d = new Date(`${date}T00:00`);
  return Number.isNaN(d.getTime()) ? null : weekdayIndex(d);
}

/** The days a weekly form will send: the user's own pick, else the start date's. */
export function effectiveWeekdays(form: RecurrenceForm, startDate: string): number[] {
  if (form.weekdays) return form.weekdays;
  const own = weekdayOfDate(startDate);
  return own === null ? [] : [own];
}

/** Toggle one day, materialising the default first so the first click adds to it
 *  rather than replacing it. Kept in calendar order. */
export function toggleWeekday(form: RecurrenceForm, startDate: string, day: number): RecurrenceForm {
  const current = new Set(effectiveWeekdays(form, startDate));
  if (current.has(day)) current.delete(day);
  else current.add(day);
  return { ...form, weekdays: [...current].sort((a, b) => a - b) };
}

/** A weekday's name, in the app's language. Formatted from a fixed known Monday
 *  (2024-01-01) so no string is hard-coded and the names follow the locale. */
export function weekdayName(day: number, style: "long" | "short" | "narrow"): string {
  return new Date(2024, 0, 1 + day).toLocaleDateString(i18n.language, { weekday: style });
}

export interface RecurrenceErrors {
  interval?: string;
  weekdays?: string;
  endDate?: string;
  occurrenceCount?: string;
}

const isWholeNumber = (s: string) => /^\d+$/.test(s.trim());

/** Always the true current answer; showing it is the component's decision. */
export function validateRecurrence(
  t: TFunction,
  form: RecurrenceForm,
  startDate: string,
): RecurrenceErrors {
  const errors: RecurrenceErrors = {};
  if (form.repeat === "NONE") return errors;

  const interval = Number(form.interval);
  if (!isWholeNumber(form.interval) || interval < 1 || interval > MAX_INTERVAL) {
    errors.interval = t("newMeeting.repeat.errors.interval", { max: MAX_INTERVAL });
  }
  if (form.repeat === "WEEKLY" && effectiveWeekdays(form, startDate).length === 0) {
    errors.weekdays = t("newMeeting.repeat.errors.weekdays");
  }
  if (form.endCondition === "ON_DATE") {
    if (!form.endDate) errors.endDate = t("newMeeting.repeat.errors.endDateRequired");
    else if (startDate && form.endDate < startDate) {
      // ISO dates order lexicographically.
      errors.endDate = t("newMeeting.repeat.errors.endDateBeforeStart");
    }
  }
  if (form.endCondition === "AFTER_OCCURRENCES") {
    const n = Number(form.occurrenceCount);
    if (!isWholeNumber(form.occurrenceCount) || n < 1 || n > MAX_OCCURRENCES) {
      errors.occurrenceCount = t("newMeeting.repeat.errors.occurrenceCount", { max: MAX_OCCURRENCES });
    }
  }
  return errors;
}

/** The IANA zone the browser reports, which is the zone a person picking
 *  "10:00" means. UTC only if the runtime will not say — better a stated,
 *  stable zone than a schedule anchored to nothing. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The calendar date ("YYYY-MM-DD") of an instant on the wall of `timeZone` — the
 *  date a series' first meeting is on for the organiser who set it, which is not
 *  necessarily the date in the zone of whoever is now editing it. */
export function dateInZone(iso: string, timeZone: string): string {
  try {
    // en-CA prints ISO order (2026-10-05); the zone does the rest.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** The request body for a form, or undefined for "does not repeat". Assumes the
 *  form has passed validateRecurrence. Sends only the fields its end condition
 *  uses — the server refuses stray ones. */
export function toRecurrenceInput(
  form: RecurrenceForm,
  startDate: string,
  timeZone: string,
): MeetingRecurrenceInput | undefined {
  if (form.repeat === "NONE") return undefined;
  const out: MeetingRecurrenceInput = {
    frequency: form.repeat,
    interval: Number(form.interval),
    endCondition: form.endCondition,
    timeZone,
  };
  if (form.repeat === "WEEKLY") out.weekdays = effectiveWeekdays(form, startDate);
  if (form.endCondition === "ON_DATE") out.endDate = form.endDate;
  if (form.endCondition === "AFTER_OCCURRENCES") out.occurrenceCount = Number(form.occurrenceCount);
  return out;
}

/** A saved rule back into a form, for editing. */
export function formFromRecurrence(r: RecurrenceDTO): RecurrenceForm {
  return {
    repeat: r.frequency,
    interval: String(r.interval),
    weekdays: r.frequency === "WEEKLY" ? [...r.weekdays].sort((a, b) => a - b) : null,
    endCondition: r.endCondition,
    endDate: r.endDate ?? "",
    occurrenceCount: r.occurrenceCount != null ? String(r.occurrenceCount) : "10",
  };
}

const UNIT_KEY: Record<RecurrenceFrequency, string> = {
  DAILY: "day",
  WEEKLY: "week",
  MONTHLY: "month",
};

/** The unit noun for "Every N …", pluralised by N. */
export function unitLabel(t: TFunction, repeat: RecurrenceFrequency, count: number): string {
  return t(`newMeeting.repeat.unit.${UNIT_KEY[repeat]}`, { count });
}

/** "Repeats every 2 weeks on Tue, Thu, until 31 Dec 2026" — for a meeting's
 *  detail page. */
export function describeRecurrence(t: TFunction, r: RecurrenceDTO): string {
  const days = [...r.weekdays]
    .sort((a, b) => a - b)
    .map((d) => weekdayName(d, "short"))
    .join(", ");
  const every = t(`series.summary.${UNIT_KEY[r.frequency]}`, { count: r.interval, days });

  if (r.endCondition === "ON_DATE" && r.endDate) {
    const date = new Date(`${r.endDate}T00:00`).toLocaleDateString(i18n.language, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    return t("series.summary.withEnd", { repeat: every, end: t("series.summary.until", { date }) });
  }
  if (r.endCondition === "AFTER_OCCURRENCES" && r.occurrenceCount != null) {
    return t("series.summary.withEnd", {
      repeat: every,
      end: t("series.summary.times", { count: r.occurrenceCount }),
    });
  }
  return every;
}
