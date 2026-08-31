import { describe, expect, it } from "vitest";
import type { CallDTO } from "@taskboard/shared";
import { whenLabel, whenOf } from "./meetingTime";

function call(over: Partial<CallDTO> = {}): CallDTO {
  return {
    id: "018f0000-0000-7000-8000-000000000001",
    orgId: "org",
    kind: "MEETING",
    title: "Weekly review",
    media: "video",
    createdBy: "me",
    status: "SCHEDULED",
    createdAt: new Date(0).toISOString(),
    participants: [],
    activeShares: [],
    ...over,
  } as CallDTO;
}

describe("whenLabel", () => {
  it("shows only the start time when nothing about an end is known", () => {
    const label = whenLabel(call({ scheduledAt: "2026-09-01T10:00:00Z" }));
    expect(label).not.toContain("–");
  });

  // THE gap this closes: a meeting scheduled through the New Meeting popup's
  // End Time field has a real, known endsAt long before it ever runs —
  // "Upcoming" must say so, not wait until the call is already over.
  it("shows the PLANNED end (endsAt) for a call that has not happened yet", () => {
    const label = whenLabel(
      call({ scheduledAt: "2026-09-01T10:00:00Z", endsAt: "2026-09-01T11:00:00Z" }),
    );
    expect(label).toContain("–");
    expect(label).toContain("11:00");
  });

  it("prefers the ACTUAL end (endedAt) once a call has genuinely finished", () => {
    const label = whenLabel(
      call({
        scheduledAt: "2026-09-01T10:00:00Z",
        endsAt: "2026-09-01T11:00:00Z",
        endedAt: "2026-09-01T10:47:00Z",
        status: "ENDED",
      }),
    );
    expect(label).toContain("10:47");
    expect(label).not.toContain("11:00");
  });

  it("spells out the end's own day when a call runs past midnight", () => {
    // Relative to whenever this runs, not a fixed calendar date — the point is
    // the two timestamps straddle a day boundary, not which day it is.
    const start = new Date();
    start.setHours(23, 30, 0, 0);
    const end = new Date(start.getTime() + 45 * 60_000); // 00:15 the next day
    const label = whenLabel(
      call({ scheduledAt: start.toISOString(), endsAt: end.toISOString() }),
    );
    expect(label).toContain("–");
    // The end's day label ("Today"/"Tomorrow"/a date) appears in the tail, not
    // just a bare time — that is the whole point of the same-day check.
    expect(label.split("–")[1]?.trim().length).toBeGreaterThan("12:15 AM".length);
  });
});

describe("whenOf", () => {
  it("uses scheduledAt when present", () => {
    const c = call({ scheduledAt: "2026-09-01T10:00:00Z" });
    expect(whenOf(c)).toBe(new Date("2026-09-01T10:00:00Z").getTime());
  });

  it("falls back to startedAt for a 'meet now' call with no scheduledAt", () => {
    const c = call({ scheduledAt: undefined, startedAt: "2026-09-01T10:05:00Z" });
    expect(whenOf(c)).toBe(new Date("2026-09-01T10:05:00Z").getTime());
  });
});
