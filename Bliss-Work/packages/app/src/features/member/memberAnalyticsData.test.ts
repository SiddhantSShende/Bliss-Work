import { describe, expect, it } from "vitest";
import type { DayBucket } from "@taskboard/shared";
import { percentChange, previousRange, weekdayAverages } from "./memberAnalyticsData";

const day = (d: string, activeMs: number, idleMs = 0): DayBucket =>
  ({ day: d, activeMs, idleMs, onlineMs: 0, sessions: 0, events: 0 });

describe("previousRange", () => {
  it("is the same-length window ending the day before `from`", () => {
    expect(previousRange("2026-10-01", "2026-10-07")).toEqual({ from: "2026-09-24", to: "2026-09-30" });
  });
  it("crosses a month boundary for a 30-day range", () => {
    expect(previousRange("2026-09-08", "2026-10-07")).toEqual({ from: "2026-08-09", to: "2026-09-07" });
  });
});

describe("percentChange", () => {
  it("rounds to a whole percent, up or down", () => {
    expect(percentChange(112, 100)).toBe(12);
    expect(percentChange(94, 100)).toBe(-6);
  });
  it("is null when there is no previous value to compare against", () => {
    expect(percentChange(50, 0)).toBeNull();
  });
});

describe("weekdayAverages", () => {
  it("returns the daily values themselves for a 7-day range, Monday first", () => {
    // 2026-10-05 is a Monday.
    const out = weekdayAverages(
      [day("2026-10-05", 60_000, 10_000), day("2026-10-11", 30_000)],
      "2026-10-05", "2026-10-11",
    );
    expect(out[0]).toEqual({ active: 60_000, idle: 10_000 });
    expect(out[6]).toEqual({ active: 30_000, idle: 0 });
    expect(out[3]).toEqual({ active: 0, idle: 0 });
  });
  it("averages per calendar day, counting days without a row as zero", () => {
    // Two Mondays in range, only one has a row.
    const out = weekdayAverages([day("2026-10-05", 120_000)], "2026-10-05", "2026-10-12");
    expect(out[0]!.active).toBe(60_000);
  });
});
