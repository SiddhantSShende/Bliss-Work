/**
 * Regression coverage for `parseLocalDay`.
 *
 * It exists because `new Date("YYYY-MM-DD")` parses as UTC midnight.
 * Formatting that with `toLocaleDateString()` in a timezone behind UTC —
 * anywhere in the Americas, in the evening — renders the day BEFORE the one
 * the server actually bucketed. OrgActivity.tsx and MemberAnalytics.tsx both
 * parse a `day` bucket this way before labelling a chart with it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDay, parseLocalDay } from "./dateRange";

describe("parseLocalDay, west of UTC", () => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/New_York";
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("reads a day bucket as its own local calendar date", () => {
    const d = parseLocalDay("2026-01-02");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0); // January
    expect(d.getDate()).toBe(2);
  });

  // Documents the exact regression this function guards against: naive UTC
  // parsing of the same string reads it as the day before, in this timezone.
  it("would have been misread by naive `new Date(string)` parsing", () => {
    expect(new Date("2026-01-02").getDate()).toBe(1);
  });

  it("round-trips with localDay", () => {
    const d = new Date(2026, 0, 2, 15); // 2026-01-02, 3 PM local
    expect(parseLocalDay(localDay(d)).getDate()).toBe(2);
  });
});
