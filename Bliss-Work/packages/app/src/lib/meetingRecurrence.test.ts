import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import type { RecurrenceDTO } from "@taskboard/shared";
import {
  MAX_INTERVAL,
  MAX_OCCURRENCES,
  dateInZone,
  describeRecurrence,
  effectiveWeekdays,
  emptyRecurrence,
  formFromRecurrence,
  toRecurrenceInput,
  toggleWeekday,
  validateRecurrence,
  weekdayIndex,
  weekdayName,
  weekdayOfDate,
  type RecurrenceForm,
} from "./meetingRecurrence";

const t = i18n.getFixedT("en", "meetings");

const form = (over: Partial<RecurrenceForm>): RecurrenceForm => ({ ...emptyRecurrence(), ...over });

// 2026-10-05 is a Monday.
const MONDAY = "2026-10-05";
const SUNDAY = "2026-10-11";

describe("weekday numbering", () => {
  // The API's weekdays start at Monday = 0; Date#getDay() starts at Sunday = 0.
  // Passing getDay() straight through would put every weekly meeting a day out.
  it("is Monday-first, unlike Date#getDay()", () => {
    expect(weekdayIndex(new Date(2026, 9, 5))).toBe(0); // Mon
    expect(weekdayIndex(new Date(2026, 9, 7))).toBe(2); // Wed
    expect(weekdayIndex(new Date(2026, 9, 11))).toBe(6); // Sun
    expect(new Date(2026, 9, 11).getDay()).toBe(0); // …which getDay() calls 0
  });

  it("reads the weekday off a form date", () => {
    expect(weekdayOfDate(MONDAY)).toBe(0);
    expect(weekdayOfDate(SUNDAY)).toBe(6);
    expect(weekdayOfDate("")).toBeNull();
    expect(weekdayOfDate("not a date")).toBeNull();
  });

  it("names weekdays in the app's language without a hard-coded list", () => {
    expect(weekdayName(0, "long")).toBe("Monday");
    expect(weekdayName(6, "long")).toBe("Sunday");
    expect(weekdayName(2, "short")).toBe("Wed");
    expect(weekdayName(4, "narrow")).toBe("F");
  });
});

describe("the default weekday", () => {
  // "The selected meeting date's weekday should initially be selected."
  it("follows the start date until the user picks days themselves", () => {
    const f = form({ repeat: "WEEKLY" });
    expect(effectiveWeekdays(f, MONDAY)).toEqual([0]);
    expect(effectiveWeekdays(f, SUNDAY)).toEqual([6]);
    expect(effectiveWeekdays(f, "")).toEqual([]);
  });

  it("the first click ADDS to the default rather than replacing it", () => {
    const f = toggleWeekday(form({ repeat: "WEEKLY" }), MONDAY, 2);
    expect(f.weekdays).toEqual([0, 2]);
  });

  it("clicking the default day takes it off, and the pick then stops following the date", () => {
    const off = toggleWeekday(form({ repeat: "WEEKLY" }), MONDAY, 0);
    expect(off.weekdays).toEqual([]);
    expect(effectiveWeekdays(off, SUNDAY)).toEqual([]); // no longer tied to the start date
  });

  it("keeps the days in calendar order whatever order they were clicked in", () => {
    let f = form({ repeat: "WEEKLY", weekdays: [] });
    for (const d of [4, 0, 2]) f = toggleWeekday(f, MONDAY, d);
    expect(f.weekdays).toEqual([0, 2, 4]);
  });

  it("never lists a day twice", () => {
    let f = form({ repeat: "WEEKLY", weekdays: [1] });
    f = toggleWeekday(f, MONDAY, 3);
    f = toggleWeekday(f, MONDAY, 3);
    f = toggleWeekday(f, MONDAY, 3);
    expect(f.weekdays).toEqual([1, 3]);
  });
});

describe("validateRecurrence", () => {
  it("has nothing to say about a meeting that does not repeat", () => {
    expect(validateRecurrence(t, form({ repeat: "NONE", interval: "0" }), MONDAY)).toEqual({});
  });

  it("accepts a plain, valid rule", () => {
    expect(validateRecurrence(t, form({ repeat: "DAILY" }), MONDAY)).toEqual({});
    expect(validateRecurrence(t, form({ repeat: "WEEKLY" }), MONDAY)).toEqual({});
  });

  it.each([["0"], [""], ["-1"], ["1.5"], ["abc"], [String(MAX_INTERVAL + 1)]])(
    "refuses the interval %j",
    (interval) => {
      const errs = validateRecurrence(t, form({ repeat: "DAILY", interval }), MONDAY);
      expect(errs.interval).toBe(`Enter a whole number from 1 to ${MAX_INTERVAL}.`);
    },
  );

  it("accepts the interval at both bounds", () => {
    for (const interval of ["1", String(MAX_INTERVAL)]) {
      expect(validateRecurrence(t, form({ repeat: "DAILY", interval }), MONDAY).interval).toBeUndefined();
    }
  });

  it("weekly with no weekday is refused", () => {
    const errs = validateRecurrence(t, form({ repeat: "WEEKLY", weekdays: [] }), MONDAY);
    expect(errs.weekdays).toBe("Pick at least one day.");
    // …but only weekly cares.
    expect(validateRecurrence(t, form({ repeat: "DAILY", weekdays: [] }), MONDAY).weekdays).toBeUndefined();
  });

  it("weekly is refused when the start date is empty and no day was picked", () => {
    expect(validateRecurrence(t, form({ repeat: "WEEKLY" }), "").weekdays).toBeDefined();
  });

  it("an end date is required, and cannot be before the first meeting", () => {
    const base = form({ repeat: "DAILY", endCondition: "ON_DATE" });
    expect(validateRecurrence(t, { ...base, endDate: "" }, MONDAY).endDate).toBe("Choose an end date.");
    expect(validateRecurrence(t, { ...base, endDate: "2026-10-04" }, MONDAY).endDate).toBe(
      "The end date can't be before the first meeting.",
    );
    // The start day itself is allowed: a series can end the day it begins.
    expect(validateRecurrence(t, { ...base, endDate: MONDAY }, MONDAY).endDate).toBeUndefined();
    expect(validateRecurrence(t, { ...base, endDate: "2027-01-01" }, MONDAY).endDate).toBeUndefined();
  });

  it.each([["0"], [""], ["-3"], ["2.5"], [String(MAX_OCCURRENCES + 1)]])(
    "refuses %j occurrences",
    (occurrenceCount) => {
      const errs = validateRecurrence(
        t,
        form({ repeat: "DAILY", endCondition: "AFTER_OCCURRENCES", occurrenceCount }),
        MONDAY,
      );
      expect(errs.occurrenceCount).toBe(`Enter a whole number from 1 to ${MAX_OCCURRENCES}.`);
    },
  );

  it("ignores an end field the chosen end condition does not use", () => {
    const errs = validateRecurrence(
      t,
      form({ repeat: "DAILY", endCondition: "NO_END", endDate: "", occurrenceCount: "0" }),
      MONDAY,
    );
    expect(errs).toEqual({});
  });
});

describe("toRecurrenceInput", () => {
  it("is undefined when the meeting does not repeat", () => {
    expect(toRecurrenceInput(form({ repeat: "NONE" }), MONDAY, "UTC")).toBeUndefined();
  });

  it("weekly Monday, Wednesday, Friday, every week, never ending", () => {
    const input = toRecurrenceInput(form({ repeat: "WEEKLY", weekdays: [0, 2, 4] }), MONDAY, "Europe/Berlin");
    expect(input).toEqual({
      frequency: "WEEKLY",
      interval: 1,
      weekdays: [0, 2, 4],
      endCondition: "NO_END",
      timeZone: "Europe/Berlin",
    });
  });

  it("weekly with no pick sends the start date's weekday", () => {
    expect(toRecurrenceInput(form({ repeat: "WEEKLY" }), SUNDAY, "UTC")?.weekdays).toEqual([6]);
  });

  it("every 2 weeks on Tuesday and Thursday", () => {
    const input = toRecurrenceInput(form({ repeat: "WEEKLY", interval: "2", weekdays: [1, 3] }), MONDAY, "UTC");
    expect(input).toMatchObject({ frequency: "WEEKLY", interval: 2, weekdays: [1, 3] });
  });

  // The server refuses stray fields rather than ignoring them, so the payload
  // must carry exactly the fields its own frequency and end condition use.
  it("sends only the fields the rule uses", () => {
    const daily = toRecurrenceInput(form({ repeat: "DAILY", weekdays: [1, 2] }), MONDAY, "UTC");
    expect(daily).not.toHaveProperty("weekdays");
    const never = toRecurrenceInput(form({ repeat: "DAILY", endDate: "2027-01-01", occurrenceCount: "5" }), MONDAY, "UTC");
    expect(never).not.toHaveProperty("endDate");
    expect(never).not.toHaveProperty("occurrenceCount");
  });

  it("on a date", () => {
    const input = toRecurrenceInput(
      form({ repeat: "MONTHLY", endCondition: "ON_DATE", endDate: "2027-03-31" }),
      MONDAY,
      "UTC",
    );
    expect(input).toEqual({
      frequency: "MONTHLY",
      interval: 1,
      endCondition: "ON_DATE",
      endDate: "2027-03-31",
      timeZone: "UTC",
    });
  });

  it("after a number of occurrences", () => {
    const input = toRecurrenceInput(
      form({ repeat: "DAILY", endCondition: "AFTER_OCCURRENCES", occurrenceCount: "12" }),
      MONDAY,
      "UTC",
    );
    expect(input).toMatchObject({ endCondition: "AFTER_OCCURRENCES", occurrenceCount: 12 });
  });
});

describe("formFromRecurrence", () => {
  const dto = (over: Partial<RecurrenceDTO>): RecurrenceDTO => ({
    frequency: "WEEKLY",
    interval: 2,
    weekdays: [3, 1],
    endCondition: "NO_END",
    timeZone: "UTC",
    ...over,
  });

  it("restores what was saved, so an edit round-trips", () => {
    const saved = dto({ endCondition: "AFTER_OCCURRENCES", occurrenceCount: 8 });
    const f = formFromRecurrence(saved);
    expect(f).toMatchObject({ repeat: "WEEKLY", interval: "2", weekdays: [1, 3], endCondition: "AFTER_OCCURRENCES", occurrenceCount: "8" });
    expect(toRecurrenceInput(f, MONDAY, "UTC")).toEqual({
      frequency: "WEEKLY",
      interval: 2,
      weekdays: [1, 3],
      endCondition: "AFTER_OCCURRENCES",
      occurrenceCount: 8,
      timeZone: "UTC",
    });
  });

  it("restores an end date", () => {
    const f = formFromRecurrence(dto({ frequency: "DAILY", weekdays: [], endCondition: "ON_DATE", endDate: "2026-12-31" }));
    expect(f).toMatchObject({ repeat: "DAILY", endCondition: "ON_DATE", endDate: "2026-12-31" });
  });
});

describe("describeRecurrence", () => {
  const base: RecurrenceDTO = { frequency: "WEEKLY", interval: 1, weekdays: [4, 0, 2], endCondition: "NO_END", timeZone: "UTC" };

  it("weekly, with the days in calendar order", () => {
    expect(describeRecurrence(t, base)).toBe("Repeats weekly on Mon, Wed, Fri");
  });
  it("every N weeks", () => {
    expect(describeRecurrence(t, { ...base, interval: 2, weekdays: [1, 3] })).toBe("Repeats every 2 weeks on Tue, Thu");
  });
  it("daily and monthly", () => {
    expect(describeRecurrence(t, { ...base, frequency: "DAILY", weekdays: [] })).toBe("Repeats daily");
    expect(describeRecurrence(t, { ...base, frequency: "DAILY", interval: 3, weekdays: [] })).toBe("Repeats every 3 days");
    expect(describeRecurrence(t, { ...base, frequency: "MONTHLY", weekdays: [] })).toBe("Repeats monthly");
    expect(describeRecurrence(t, { ...base, frequency: "MONTHLY", interval: 2, weekdays: [] })).toBe("Repeats every 2 months");
  });
  it("says how it ends", () => {
    const onDate = describeRecurrence(t, { ...base, endCondition: "ON_DATE", endDate: "2026-12-31" });
    expect(onDate).toMatch(/^Repeats weekly on Mon, Wed, Fri, until .*2026/);
    expect(describeRecurrence(t, { ...base, endCondition: "AFTER_OCCURRENCES", occurrenceCount: 10 })).toBe(
      "Repeats weekly on Mon, Wed, Fri, 10 meetings in total",
    );
    expect(describeRecurrence(t, { ...base, endCondition: "AFTER_OCCURRENCES", occurrenceCount: 1 })).toBe(
      "Repeats weekly on Mon, Wed, Fri, 1 meeting in total",
    );
  });
});

describe("dateInZone", () => {
  // The same instant is on different calendar days in different places, and the
  // series' first meeting belongs to the day on ITS organiser's wall.
  it("reads the date on the named zone's wall", () => {
    const instant = "2026-10-05T23:30:00.000Z";
    expect(dateInZone(instant, "UTC")).toBe("2026-10-05");
    expect(dateInZone(instant, "Asia/Tokyo")).toBe("2026-10-06");
    expect(dateInZone(instant, "America/Los_Angeles")).toBe("2026-10-05");
  });
  it("falls back rather than throwing on a zone it does not know", () => {
    expect(dateInZone("2026-10-05T10:00:00.000Z", "Not/AZone")).toBe("2026-10-05");
  });
});
