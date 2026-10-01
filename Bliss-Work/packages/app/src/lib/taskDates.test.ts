import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../i18n";
import { describeDeadlineRule, formatTaskInstant, localDateTimeWithOffset } from "./taskDates";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("formatTaskInstant", () => {
  it("prints the viewer's local date AND time", () => {
    const iso = new Date(2026, new Date().getMonth(), 3, 16, 5).toISOString();
    const text = formatTaskInstant(iso);
    expect(text).toMatch(/3/);
    expect(text).toMatch(/4:05\s?PM/);
  });

  it("adds the year only when it is not the current one", () => {
    expect(formatTaskInstant(new Date(2001, 4, 6, 9, 30).toISOString())).toContain("2001");
    expect(formatTaskInstant(new Date().toISOString())).not.toContain(String(new Date().getFullYear()));
  });

  it("is empty for an absent or unparseable value, so a card can skip the chip", () => {
    expect(formatTaskInstant(null)).toBe("");
    expect(formatTaskInstant(undefined)).toBe("");
    expect(formatTaskInstant("")).toBe("");
    expect(formatTaskInstant("not a date")).toBe("");
  });
});

describe("describeDeadlineRule", () => {
  it("says a relative rule in words, singular and plural", () => {
    expect(describeDeadlineRule({ kind: "RELATIVE", amount: 6, unit: "HOURS", timeZone: "UTC" })).toBe("6 hours after each occurrence");
    expect(describeDeadlineRule({ kind: "RELATIVE", amount: 1, unit: "DAYS", timeZone: "UTC" })).toBe("1 day after each occurrence");
    expect(describeDeadlineRule({ kind: "RELATIVE", amount: 90, unit: "MINUTES", timeZone: "UTC" })).toBe("90 minutes after each occurrence");
  });

  it("says a fixed time as a time of day on each occurrence's date", () => {
    const text = describeDeadlineRule({ kind: "FIXED_TIME", time: "17:00", timeZone: "UTC" });
    expect(text).toMatch(/5:00\s?PM on each occurrence's date/);
  });

  it("is empty for a rule it cannot read", () => {
    expect(describeDeadlineRule({ kind: "FIXED_TIME", timeZone: "UTC" })).toBe("");
  });
});

describe("localDateTimeWithOffset", () => {
  it("is the local wall time with the UTC offset in force on that date", () => {
    const iso = localDateTimeWithOffset("2026-01-15", "10:30")!;
    expect(iso).toMatch(/^2026-01-15T10:30:00[+-]\d\d:\d\d$/);
    expect(new Date(iso).getTime()).toBe(new Date(2026, 0, 15, 10, 30).getTime());
    const summer = localDateTimeWithOffset("2026-07-15", "10:30")!;
    expect(new Date(summer).getTime()).toBe(new Date(2026, 6, 15, 10, 30).getTime());
  });

  it("is null while either part is missing", () => {
    expect(localDateTimeWithOffset("", "10:30")).toBeNull();
    expect(localDateTimeWithOffset("2026-01-15", "")).toBeNull();
  });
});
