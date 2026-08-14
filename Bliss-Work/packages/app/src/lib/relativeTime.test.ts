import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relativeTime } from "./relativeTime";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("says 'just now' rather than '0m ago'", () => {
    expect(relativeTime(ago(5_000))).toBe("just now");
  });

  it("counts minutes below the hour", () => {
    expect(relativeTime(ago(12 * MIN))).toBe("12m ago");
    expect(relativeTime(ago(59 * MIN))).toBe("59m ago");
  });

  it("counts hours below the day", () => {
    expect(relativeTime(ago(3 * HOUR))).toBe("3h ago");
  });

  it("names yesterday instead of '1d ago'", () => {
    expect(relativeTime(ago(DAY))).toBe("yesterday");
  });

  it("counts days beyond that", () => {
    expect(relativeTime(ago(5 * DAY))).toBe("5d ago");
  });

  it("clamps a future timestamp to 'just now' rather than a negative age", () => {
    // Clock skew between a member's machine and the server is normal, and
    // "-3m ago" reads as a bug.
    expect(relativeTime(new Date(NOW.getTime() + 3 * MIN).toISOString())).toBe("just now");
  });
});
