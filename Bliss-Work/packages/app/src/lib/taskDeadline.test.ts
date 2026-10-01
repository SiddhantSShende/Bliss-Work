import { describe, expect, it } from "vitest";
import {
  deadlineProblem,
  deadlineRequest,
  effectiveKind,
  emptyDeadline,
  kindsFor,
  MAX_RELATIVE_MINUTES,
  type DeadlineForm,
} from "./taskDeadline";

const NOW = new Date(2026, 8, 15, 10, 0, 0).getTime(); // Tue 15 Sep 2026, 10:00 local
const START = { date: "2026-09-16", time: "09:00" };
const NO_START = { date: "", time: "" };
const form = (over: Partial<DeadlineForm>): DeadlineForm => ({ ...emptyDeadline(), ...over });

describe("which deadline kinds an allocation offers", () => {
  it("offers a concrete date and time for a one-off task, a rule for a series — and always 'none'", () => {
    expect(kindsFor("NOW")).toEqual(["NONE", "AT"]);
    expect(kindsFor("SCHEDULED")).toEqual(["NONE", "AT"]);
    expect(kindsFor("RECURRING")).toEqual(["NONE", "RELATIVE", "FIXED"]);
  });

  it("treats a kind from the other allocation as none, so it can never leak into the request", () => {
    expect(effectiveKind(form({ kind: "AT" }), "RECURRING")).toBe("NONE");
    expect(effectiveKind(form({ kind: "RELATIVE" }), "NOW")).toBe("NONE");
    expect(effectiveKind(form({ kind: "FIXED" }), "SCHEDULED")).toBe("NONE");
    expect(effectiveKind(form({ kind: "RELATIVE" }), "RECURRING")).toBe("RELATIVE");
  });
});

describe("what the request carries", () => {
  it("nothing at all when there is no deadline, so such a task sends what it always did", () => {
    expect(deadlineRequest(emptyDeadline(), "NOW")).toEqual({});
    expect(deadlineRequest(emptyDeadline(), "RECURRING")).toEqual({});
    // a half-filled AT left behind after switching to Recurring is not sent either
    expect(deadlineRequest(form({ kind: "AT", date: "2026-09-20", time: "10:00" }), "RECURRING")).toEqual({});
  });

  it("an absolute deadline is the local date and time with the local UTC offset", () => {
    const { deadlineAt, recurrenceDeadline } = deadlineRequest(form({ kind: "AT", date: "2026-09-20", time: "16:00" }), "NOW");
    expect(deadlineAt).toMatch(/^2026-09-20T16:00:00[+-]\d\d:\d\d$/);
    expect(recurrenceDeadline).toBeUndefined();
    // the offset is the one in force on THAT date, i.e. what Date says for that instant
    expect(new Date(deadlineAt!).getTime()).toBe(new Date(2026, 8, 20, 16, 0).getTime());
  });

  it("a relative rule carries amount, unit and the IANA zone it is read in", () => {
    expect(deadlineRequest(form({ kind: "RELATIVE", amount: "6", unit: "HOURS" }), "RECURRING", "America/New_York")).toEqual({
      recurrenceDeadline: { kind: "RELATIVE", amount: 6, unit: "HOURS", timeZone: "America/New_York" },
    });
  });

  it("a fixed-time rule carries the time of day and the zone — no amount or unit", () => {
    expect(deadlineRequest(form({ kind: "FIXED", fixedTime: "17:00" }), "RECURRING", "Europe/London")).toEqual({
      recurrenceDeadline: { kind: "FIXED_TIME", time: "17:00", timeZone: "Europe/London" },
    });
  });

  it("defaults the zone to the browser's", () => {
    const { recurrenceDeadline } = deadlineRequest(form({ kind: "FIXED", fixedTime: "17:00" }), "RECURRING");
    expect(recurrenceDeadline?.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("what is wrong with the form", () => {
  it("is never a problem to have no deadline", () => {
    expect(deadlineProblem(emptyDeadline(), "NOW", NO_START, NOW)).toBeNull();
    expect(deadlineProblem(emptyDeadline(), "RECURRING", START, NOW)).toBeNull();
  });

  it("an absolute deadline needs both a date and a time", () => {
    expect(deadlineProblem(form({ kind: "AT" }), "NOW", NO_START, NOW)).toBe("needAt");
    expect(deadlineProblem(form({ kind: "AT", date: "2026-09-20" }), "NOW", NO_START, NOW)).toBe("needAt");
  });

  it("an absolute deadline must be in the future", () => {
    expect(deadlineProblem(form({ kind: "AT", date: "2026-09-15", time: "09:59" }), "NOW", NO_START, NOW)).toBe("notFuture");
    expect(deadlineProblem(form({ kind: "AT", date: "2026-09-15", time: "10:00" }), "NOW", NO_START, NOW)).toBe("notFuture");
    expect(deadlineProblem(form({ kind: "AT", date: "2026-09-15", time: "10:05" }), "NOW", NO_START, NOW)).toBeNull();
  });

  it("a scheduled task's deadline must be after the moment it is allocated", () => {
    const at = (time: string) => form({ kind: "AT", date: "2026-09-16", time });
    expect(deadlineProblem(at("08:00"), "SCHEDULED", START, NOW)).toBe("beforeStart");
    expect(deadlineProblem(at("09:00"), "SCHEDULED", START, NOW)).toBe("beforeStart");
    expect(deadlineProblem(at("09:05"), "SCHEDULED", START, NOW)).toBeNull();
  });

  it("a relative amount must be a whole number of at least 1, within a year", () => {
    for (const amount of ["", "  ", "0", "-3", "1.5", "abc"]) {
      expect(deadlineProblem(form({ kind: "RELATIVE", amount }), "RECURRING", START, NOW)).toBe("amount");
    }
    expect(deadlineProblem(form({ kind: "RELATIVE", amount: "1", unit: "MINUTES" }), "RECURRING", START, NOW)).toBeNull();
    expect(deadlineProblem(form({ kind: "RELATIVE", amount: "366", unit: "DAYS" }), "RECURRING", START, NOW)).toBeNull();
    expect(deadlineProblem(form({ kind: "RELATIVE", amount: "367", unit: "DAYS" }), "RECURRING", START, NOW)).toBe("amount");
    expect(deadlineProblem(form({ kind: "RELATIVE", amount: String(MAX_RELATIVE_MINUTES + 1), unit: "MINUTES" }), "RECURRING", START, NOW)).toBe("amount");
  });

  it("a fixed time is required, and must be later than the series' start time", () => {
    expect(deadlineProblem(form({ kind: "FIXED" }), "RECURRING", START, NOW)).toBe("needFixedTime");
    expect(deadlineProblem(form({ kind: "FIXED", fixedTime: "08:59" }), "RECURRING", START, NOW)).toBe("fixedBeforeStart");
    expect(deadlineProblem(form({ kind: "FIXED", fixedTime: "09:00" }), "RECURRING", START, NOW)).toBe("fixedBeforeStart");
    expect(deadlineProblem(form({ kind: "FIXED", fixedTime: "17:00" }), "RECURRING", START, NOW)).toBeNull();
  });
});
