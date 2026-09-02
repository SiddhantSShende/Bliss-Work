/**
 * The calendar's arithmetic.
 *
 * This is the file that decides where a meeting is DRAWN, and the whole reason
 * it is a module of pure functions rather than logic inside a grid component:
 * "is this block in the right place" is otherwise a question you can only answer
 * by looking at it, and the ways it goes wrong (a meeting placed on the wrong
 * day, one silently outside the visible hours, two clashing meetings drawn on
 * top of each other) all look like an ordinary calendar to anyone who does not
 * already know what should be there.
 *
 * Every date below is built with the local Date constructor, never parsed from
 * a UTC string, so the expectations are the viewer's own wall clock — which is
 * what the grid draws.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallDTO } from "@taskboard/shared";
import {
  DEFAULT_DAY_END_HOUR,
  DEFAULT_DAY_START_HOUR,
  anchorParam,
  daysIn,
  gridRangeOf,
  hourRows,
  hourWindowFor,
  layOutDay,
  nowLinePct,
  occursOn,
  occurrenceOf,
  parseAnchor,
  shiftAnchor,
  startOfWeek,
} from "./meetingCalendar";

function at(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min).getTime();
}

function call(over: Partial<CallDTO> = {}): CallDTO {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    orgId: "22222222-2222-2222-2222-222222222222",
    kind: "MEETING",
    title: "Planning",
    media: "video",
    createdBy: "u-host",
    status: "SCHEDULED",
    createdAt: new Date(at(2026, 9, 1, 9)).toISOString(),
    participants: [],
    activeShares: [],
    ...over,
  } as CallDTO;
}

/** A scheduled meeting between two local wall-clock times. */
function between(start: number, end: number, over: Partial<CallDTO> = {}): CallDTO {
  return call({
    scheduledAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    ...over,
  });
}

describe("the week a date belongs to", () => {
  it("starts on Monday, whichever day of it you ask from", () => {
    // Monday 31 August 2026 through Sunday 6 September are one week.
    const monday = at(2026, 8, 31);
    const week = [
      at(2026, 8, 31, 13),
      at(2026, 9, 1, 0),
      at(2026, 9, 2, 9),
      at(2026, 9, 3, 17),
      at(2026, 9, 4, 23, 59),
      at(2026, 9, 5, 6),
      at(2026, 9, 6, 20),
    ];
    for (const t of week) expect(startOfWeek(t)).toBe(monday);
  });

  it("treats a Sunday as the END of its week, not the start of the next", () => {
    // Sunday 6 September 2026 belongs to the week that began Monday the 31st.
    expect(startOfWeek(at(2026, 9, 6))).toBe(at(2026, 8, 31));
  });

  it("draws exactly seven days", () => {
    expect(daysIn(gridRangeOf(at(2026, 9, 2), "week"))).toHaveLength(7);
  });
});

describe("the month grid", () => {
  it("is made of whole weeks, so the first row is not ragged", () => {
    const days = daysIn(gridRangeOf(at(2026, 9, 15), "month"));
    expect(days.length % 7).toBe(0);
    expect(new Date(days[0]!).getDay()).toBe(1); // Monday
  });

  it("covers every day of the anchored month", () => {
    const days = daysIn(gridRangeOf(at(2026, 9, 15), "month"));
    expect(days).toContain(at(2026, 9, 1));
    expect(days).toContain(at(2026, 9, 30));
  });

  // A month with 31 days starting on a Sunday needs six rows. Getting this
  // wrong drops the last days of the month off the bottom of the grid.
  it("grows to six weeks when the month needs them", () => {
    // August 2026 starts on a Saturday and has 31 days.
    const days = daysIn(gridRangeOf(at(2026, 8, 10), "month"));
    expect(days).toContain(at(2026, 8, 31));
  });
});

describe("paging", () => {
  it("moves a week at a time in the week view", () => {
    expect(shiftAnchor(at(2026, 9, 2), "week", 1)).toBe(at(2026, 9, 9));
    expect(shiftAnchor(at(2026, 9, 2), "week", -1)).toBe(at(2026, 8, 26));
  });

  // By CALENDAR month, not by 30 days — otherwise paging forward and back does
  // not return where it started, and February drifts.
  it("moves a calendar month at a time in the month view, and comes back", () => {
    const jan31 = at(2026, 1, 31);
    const forward = shiftAnchor(jan31, "month", 1);
    expect(new Date(forward).getMonth()).toBe(1); // February
    expect(shiftAnchor(forward, "month", -1)).toBe(at(2026, 1, 1));
  });
});

describe("the anchor in the URL", () => {
  it("round-trips a local day", () => {
    expect(parseAnchor(anchorParam(at(2026, 9, 2)))).toBe(at(2026, 9, 2));
  });

  it("falls back to today rather than erroring on a hand-edited value", () => {
    const today = at(2026, 9, 2);
    expect(parseAnchor("not-a-date", today)).toBe(today);
    expect(parseAnchor(null, today)).toBe(today);
  });
});

describe("when a meeting occupies", () => {
  it("prefers the actual end over the planned one", () => {
    const c = call({
      scheduledAt: new Date(at(2026, 9, 2, 9)).toISOString(),
      endsAt: new Date(at(2026, 9, 2, 10)).toISOString(),
      endedAt: new Date(at(2026, 9, 2, 9, 20)).toISOString(),
      status: "ENDED",
    });
    expect(occurrenceOf(c).end).toBe(at(2026, 9, 2, 9, 20));
  });

  it("uses the planned end while a meeting has not finished", () => {
    expect(occurrenceOf(between(at(2026, 9, 2, 9), at(2026, 9, 2, 10))).end).toBe(
      at(2026, 9, 2, 10),
    );
  });

  // "No end time" is a real, deliberate choice. Inventing a duration for it
  // would draw a block nobody scheduled.
  it("is a point in time when there is no end at all", () => {
    const c = call({ scheduledAt: new Date(at(2026, 9, 2, 9)).toISOString(), endsAt: null });
    const o = occurrenceOf(c);
    expect(o.end).toBe(o.start);
  });

  it("belongs to BOTH days when it runs past midnight", () => {
    const c = between(at(2026, 9, 2, 23, 30), at(2026, 9, 3, 0, 30));
    expect(occursOn(c, at(2026, 9, 2))).toBe(true);
    expect(occursOn(c, at(2026, 9, 3))).toBe(true);
    expect(occursOn(c, at(2026, 9, 4))).toBe(false);
  });

  // An end landing exactly ON midnight belongs to the day it ended. Counting it
  // into the next one opens that day with a meeting of zero length.
  it("does not spill onto the next day when it ends exactly at midnight", () => {
    const c = between(at(2026, 9, 2, 23), at(2026, 9, 3, 0));
    expect(occursOn(c, at(2026, 9, 2))).toBe(true);
    expect(occursOn(c, at(2026, 9, 3))).toBe(false);
  });

  it("still belongs to its own day when it has no duration", () => {
    const c = call({ scheduledAt: new Date(at(2026, 9, 2, 9)).toISOString(), endsAt: null });
    expect(occursOn(c, at(2026, 9, 2))).toBe(true);
    expect(occursOn(c, at(2026, 9, 1))).toBe(false);
  });
});

describe("the visible hours", () => {
  const week = daysIn(gridRangeOf(at(2026, 9, 2), "week"));

  it("is the working day when nothing needs more", () => {
    expect(hourWindowFor([between(at(2026, 9, 2, 10), at(2026, 9, 2, 11))], week)).toEqual({
      startHour: DEFAULT_DAY_START_HOUR,
      endHour: DEFAULT_DAY_END_HOUR,
    });
  });

  // The default working day is the LOOK, not a filter. A 7 AM stand-up clamped
  // out of a 9-to-6 grid is a meeting that silently does not exist.
  it("opens earlier for a meeting before the working day", () => {
    expect(hourWindowFor([between(at(2026, 9, 2, 7), at(2026, 9, 2, 8))], week).startHour).toBe(7);
  });

  it("opens later for one that runs past it", () => {
    expect(hourWindowFor([between(at(2026, 9, 2, 17), at(2026, 9, 2, 19, 30))], week).endHour).toBe(
      20,
    );
  });

  it("measures each edge against its OWN day, not against the start of the week", () => {
    // Thursday, 07:00 — three days into the window. A naive offset from Monday
    // midnight would read this as hour 79 and blow the grid open.
    const win = hourWindowFor([between(at(2026, 9, 3, 7), at(2026, 9, 3, 8))], week);
    expect(win.startHour).toBe(7);
    expect(win.endHour).toBe(DEFAULT_DAY_END_HOUR);
  });

  it("ignores meetings outside the window entirely", () => {
    expect(hourWindowFor([between(at(2026, 10, 20, 6), at(2026, 10, 20, 7))], week)).toEqual({
      startHour: DEFAULT_DAY_START_HOUR,
      endHour: DEFAULT_DAY_END_HOUR,
    });
  });

  // Regression: measured against the meeting AS A WHOLE, a 23:30–00:30 meeting
  // widens neither day — its start hour belongs to one and its end hour to the
  // next — and layOutDay then clips it out of both. A meeting that silently
  // does not exist is the worst thing a calendar can do.
  it("opens for a meeting that runs across midnight, on both of its days", () => {
    const win = hourWindowFor([between(at(2026, 9, 2, 23, 30), at(2026, 9, 3, 0, 30))], week);
    expect(win.startHour).toBe(0);
    expect(win.endHour).toBe(24);
    // And with the window it just asked for, both slices are actually drawn.
    expect(layOutDay([between(at(2026, 9, 2, 23, 30), at(2026, 9, 3, 0, 30))], at(2026, 9, 2), win))
      .toHaveLength(1);
    expect(layOutDay([between(at(2026, 9, 2, 23, 30), at(2026, 9, 3, 0, 30))], at(2026, 9, 3), win))
      .toHaveLength(1);
  });

  // Same trap for a meeting with no end at all: there is no end hour to widen
  // by, so the window has to account for the minimum block that WILL be drawn.
  it("opens for a late meeting that has no end time", () => {
    const c = call({ scheduledAt: new Date(at(2026, 9, 2, 23, 50)).toISOString(), endsAt: null });
    const win = hourWindowFor([c], week);
    expect(win.endHour).toBe(24);
    expect(layOutDay([c], at(2026, 9, 2), win)).toHaveLength(1);
  });

  it("labels one row per visible hour", () => {
    expect(hourRows({ startHour: 9, endHour: 12 })).toEqual([9, 10, 11]);
  });
});

describe("placing blocks on a day", () => {
  const win = { startHour: 9, endHour: 18 }; // nine hours
  const day = at(2026, 9, 2);

  it("positions and sizes a block from its real start and end", () => {
    const [p] = layOutDay([between(at(2026, 9, 2, 12), at(2026, 9, 2, 13, 30))], day, win);
    // Noon is three hours into a nine-hour window; ninety minutes is 1/6 of it.
    expect(p!.topPct).toBeCloseTo((3 / 9) * 100, 5);
    expect(p!.heightPct).toBeCloseTo((1.5 / 9) * 100, 5);
  });

  it("clips a meeting that started before the visible hours to the top", () => {
    const [p] = layOutDay([between(at(2026, 9, 2, 8), at(2026, 9, 2, 10))], day, win);
    expect(p!.topPct).toBe(0);
    expect(p!.heightPct).toBeCloseTo((1 / 9) * 100, 5);
  });

  it("gives a meeting with no end a readable block rather than none", () => {
    const c = call({ scheduledAt: new Date(at(2026, 9, 2, 12)).toISOString(), endsAt: null });
    const [p] = layOutDay([c], day, win);
    expect(p!.heightPct).toBeGreaterThan(0);
  });

  it("lays two clashing meetings side by side, not on top of each other", () => {
    const placed = layOutDay(
      [
        between(at(2026, 9, 2, 10), at(2026, 9, 2, 11)),
        between(at(2026, 9, 2, 10, 30), at(2026, 9, 2, 11, 30), { id: "b" }),
      ],
      day,
      win,
    );
    expect(placed.map((p) => p.column).sort()).toEqual([0, 1]);
    expect(placed.every((p) => p.columns === 2)).toBe(true);
  });

  it("widens the lanes to the size of the clash, not to a fixed guess", () => {
    const placed = layOutDay(
      [
        between(at(2026, 9, 2, 10), at(2026, 9, 2, 12), { id: "a" }),
        between(at(2026, 9, 2, 10), at(2026, 9, 2, 12), { id: "b" }),
        between(at(2026, 9, 2, 10), at(2026, 9, 2, 12), { id: "c" }),
      ],
      day,
      win,
    );
    expect(placed.every((p) => p.columns === 3)).toBe(true);
  });

  it("gives a meeting that does not clash the full width back", () => {
    const placed = layOutDay(
      [
        between(at(2026, 9, 2, 10), at(2026, 9, 2, 11), { id: "a" }),
        between(at(2026, 9, 2, 15), at(2026, 9, 2, 16), { id: "b" }),
      ],
      day,
      win,
    );
    expect(placed.every((p) => p.columns === 1)).toBe(true);
  });

  it("leaves out a meeting that is on another day", () => {
    expect(layOutDay([between(at(2026, 9, 5, 10), at(2026, 9, 5, 11))], day, win)).toHaveLength(0);
  });
});

describe("a DST transition day", () => {
  // Real 2026 US transition dates: clocks spring forward an hour on 8 March
  // (that day has only 23 real hours) and fall back an hour on 1 November
  // (that day has 25). `hourWindowFor`, `layOutDay` and `nowLinePct` all
  // convert between a wall-clock hour and an epoch instant — doing that with
  // flat `hour * 3_600_000` arithmetic silently assumes every day is exactly
  // 24 of them, which puts a meeting a whole row off from the one it is
  // labelled against on either of these two dates a year.
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/New_York";
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("does not widen the window for a working-hours meeting on the spring-forward day", () => {
    const day = at(2026, 3, 8);
    const win = hourWindowFor([between(at(2026, 3, 8, 9), at(2026, 3, 8, 9, 30))], [day]);
    // The flat-ms bug read the meeting's real 9 AM start as only 8 hours past
    // midnight (the skipped clock hour) and widened the window to fit it.
    expect(win).toEqual({ startHour: DEFAULT_DAY_START_HOUR, endHour: DEFAULT_DAY_END_HOUR });
  });

  it("draws a 9 AM meeting flush against the 9 AM row, not 8 AM, on the spring-forward day", () => {
    const day = at(2026, 3, 8);
    const win = { startHour: 9, endHour: 18 };
    const [p] = layOutDay([between(at(2026, 3, 8, 9), at(2026, 3, 8, 9, 30))], day, win);
    expect(p!.topPct).toBe(0);
  });

  it("does not widen the window for a working-hours meeting on the fall-back day", () => {
    const day = at(2026, 11, 1);
    const win = hourWindowFor([between(at(2026, 11, 1, 9), at(2026, 11, 1, 9, 30))], [day]);
    // The flat-ms bug read the meeting's real 9 AM start as 10 hours past
    // midnight (the repeated clock hour), which happened not to widen the
    // window but still misdrew the block — see the layOutDay case below.
    expect(win).toEqual({ startHour: DEFAULT_DAY_START_HOUR, endHour: DEFAULT_DAY_END_HOUR });
  });

  it("draws a 9 AM meeting flush against the 9 AM row, not 10 AM, on the fall-back day", () => {
    const day = at(2026, 11, 1);
    const win = { startHour: 9, endHour: 18 };
    const [p] = layOutDay([between(at(2026, 11, 1, 9), at(2026, 11, 1, 9, 30))], day, win);
    expect(p!.topPct).toBe(0);
  });

  it("lines the now line up with a block at the same real moment", () => {
    const day = at(2026, 11, 1);
    const win = { startHour: 9, endHour: 18 };
    const now = at(2026, 11, 1, 12, 15);
    const [p] = layOutDay([between(at(2026, 11, 1, 12, 15), at(2026, 11, 1, 13))], day, win);
    expect(nowLinePct(day, win, now)).toBeCloseTo(p!.topPct, 5);
  });
});

describe("the now line", () => {
  const win = { startHour: 9, endHour: 18 };

  it("sits at the fraction of the window that has elapsed", () => {
    expect(nowLinePct(at(2026, 9, 2), win, at(2026, 9, 2, 12))).toBeCloseTo((3 / 9) * 100, 5);
  });

  it("is absent on any day but today", () => {
    expect(nowLinePct(at(2026, 9, 3), win, at(2026, 9, 2, 12))).toBeNull();
  });

  it("is absent outside the visible hours", () => {
    expect(nowLinePct(at(2026, 9, 2), win, at(2026, 9, 2, 7))).toBeNull();
  });
});
