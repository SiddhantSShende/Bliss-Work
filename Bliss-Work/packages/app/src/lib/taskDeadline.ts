/**
 * The Deadline half of the New task form: its state, its rules and the request
 * it becomes. Pure, so it is testable without rendering. task-svc enforces every
 * rule again — this states them where the person can act on them.
 *
 * What a deadline IS depends on the allocation:
 *   NOW / SCHEDULED  one concrete date + time (`AT`) -> `deadlineAt`.
 *   RECURRING        a RULE, because a series has no single deadline — each
 *                    occurrence gets its own, worked out by task-svc:
 *                      RELATIVE  "N minutes|hours|days after each occurrence"
 *                      FIXED     "HH:MM on each occurrence's date"
 *                    -> `recurrence.deadline`, with the browser's IANA zone so a
 *                    wall-clock time keeps its meaning across DST changes.
 */
import type { DeadlineRule } from "@taskboard/shared";
import { browserTimeZone } from "./meetingRecurrence";
import { localDateTimeWithOffset } from "./taskDates";

export type Allocation = "NOW" | "SCHEDULED" | "RECURRING";
export type DeadlineKind = "NONE" | "AT" | "RELATIVE" | "FIXED";
export type DeadlineUnit = "MINUTES" | "HOURS" | "DAYS";

export interface DeadlineForm {
  kind: DeadlineKind;
  /** AT: YYYY-MM-DD, local. */
  date: string;
  /** AT: 24-hour HH:mm, local. */
  time: string;
  /** RELATIVE. Text, so a cleared field can be empty rather than snapping back. */
  amount: string;
  unit: DeadlineUnit;
  /** FIXED: 24-hour HH:mm, read in the browser's zone. */
  fixedTime: string;
}

export const emptyDeadline = (): DeadlineForm => ({
  kind: "NONE",
  date: "",
  time: "",
  amount: "6",
  unit: "HOURS",
  fixedTime: "",
});

/** The deadline kinds that make sense for an allocation, "no deadline" first. */
export function kindsFor(allocation: Allocation): DeadlineKind[] {
  return allocation === "RECURRING" ? ["NONE", "RELATIVE", "FIXED"] : ["NONE", "AT"];
}

/** The kind actually in force: a stale one (an `AT` left over after switching to
 *  Recurring) counts as none instead of leaking into the request. */
export function effectiveKind(form: DeadlineForm, allocation: Allocation): DeadlineKind {
  return kindsFor(allocation).includes(form.kind) ? form.kind : "NONE";
}

/** The longest relative deadline task-svc accepts, in minutes (366 days). */
export const MAX_RELATIVE_MINUTES = 366 * 24 * 60;
const UNIT_MINUTES: Record<DeadlineUnit, number> = { MINUTES: 1, HOURS: 60, DAYS: 24 * 60 };

export type DeadlineProblem = "needAt" | "notFuture" | "beforeStart" | "amount" | "needFixedTime" | "fixedBeforeStart";

/** What is wrong with the form, or null. `start` is the allocation's start, when
 *  there is one (Scheduled / Recurring), as the date and HH:mm the person picked. */
export function deadlineProblem(
  form: DeadlineForm,
  allocation: Allocation,
  start: { date: string; time: string },
  nowMs: number,
): DeadlineProblem | null {
  switch (effectiveKind(form, allocation)) {
    case "AT": {
      const at = localDateTimeWithOffset(form.date, form.time);
      if (!at) return "needAt";
      const atMs = Date.parse(at);
      if (atMs <= nowMs) return "notFuture";
      const startIso = allocation === "SCHEDULED" ? localDateTimeWithOffset(start.date, start.time) : null;
      if (startIso && atMs <= Date.parse(startIso)) return "beforeStart";
      return null;
    }
    case "RELATIVE": {
      const n = Number(form.amount);
      if (!form.amount.trim() || !Number.isInteger(n) || n < 1 || n * UNIT_MINUTES[form.unit] > MAX_RELATIVE_MINUTES) {
        return "amount";
      }
      return null;
    }
    case "FIXED":
      if (!form.fixedTime) return "needFixedTime";
      // Every occurrence is at the start's time of day, so a fixed time that is not
      // later than it would put each deadline at or before its own occurrence.
      return start.time && form.fixedTime <= start.time ? "fixedBeforeStart" : null;
    default:
      return null;
  }
}

/** The deadline part of the create-task request. Empty when there is none, so a
 *  task without one sends exactly what it always did. */
export function deadlineRequest(
  form: DeadlineForm,
  allocation: Allocation,
  timeZone: string = browserTimeZone(),
): { deadlineAt?: string; recurrenceDeadline?: DeadlineRule } {
  switch (effectiveKind(form, allocation)) {
    case "AT": {
      const at = localDateTimeWithOffset(form.date, form.time);
      return at ? { deadlineAt: at } : {};
    }
    case "RELATIVE":
      return { recurrenceDeadline: { kind: "RELATIVE", amount: Number(form.amount), unit: form.unit, timeZone } };
    case "FIXED":
      return { recurrenceDeadline: { kind: "FIXED_TIME", time: form.fixedTime, timeZone } };
    default:
      return {};
  }
}
