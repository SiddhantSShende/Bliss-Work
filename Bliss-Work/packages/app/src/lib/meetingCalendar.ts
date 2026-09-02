/**
 * The arithmetic behind the Meetings calendar: which days are on screen, where
 * a meeting sits on them, and what to call the range.
 *
 * Separate from lib/meetingTime (which answers "when does this call happen and
 * how do I say it") because this answers a different question — "where on a
 * grid does it go" — and because all of it is pure. A calendar whose block
 * positions are computed inside a component is a calendar that can only be
 * checked by looking at it; every rule here is a function with a return value.
 *
 * Nothing in this file is hardcoded to a date. `whenOf` from meetingTime is
 * reused rather than reimplemented for the same reason it was extracted in the
 * first place: two answers to "which timestamp does this call actually happen
 * at" would drift the first time a "meet now" with no scheduledAt appeared in
 * only one of them.
 */
import type { CallDTO } from "@taskboard/shared";
import { startOfDay, whenOf } from "./meetingTime";

export type CalendarScale = "week" | "month";

export const CALENDAR_SCALES: readonly { key: CalendarScale; label: string }[] = [
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

export function isCalendarScale(v: unknown): v is CalendarScale {
  return v === "week" || v === "month";
}

/**
 * The weekday a week begins on, 0 = Sunday. Monday, the business-calendar
 * convention: the controls above the grid are Today / Previous week / Next
 * week, and those only mean something against a FIXED week — a rolling
 * "today and the next six days" makes "previous week" and "today" the same
 * gesture and puts the same day in two different columns depending on when
 * you looked.
 */
const WEEK_STARTS_ON = 1;

export function addDays(t: number, days: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + days);
  // Rebuilt through the Date API rather than by adding 86_400_000 so a week
  // spanning a daylight-saving change still lands on midnight.
  return startOfDay(d.getTime());
}

export function startOfWeek(t: number): number {
  const day = new Date(t).getDay();
  return addDays(startOfDay(t), -((day - WEEK_STARTS_ON + 7) % 7));
}

export function startOfMonth(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** The half-open [start, end) the grid actually draws — whole weeks in both
 *  scales, so a month grid has square weeks rather than a ragged first row. */
export function gridRangeOf(anchor: number, scale: CalendarScale): { start: number; end: number } {
  if (scale === "week") {
    const start = startOfWeek(anchor);
    return { start, end: addDays(start, 7) };
  }
  const first = startOfMonth(anchor);
  const start = startOfWeek(first);
  const lastOfMonth = new Date(new Date(first).getFullYear(), new Date(first).getMonth() + 1, 0);
  let end = addDays(startOfWeek(lastOfMonth.getTime()), 7);
  // A month can spill into a sixth week; the loop is the general answer rather
  // than a special case for the two lengths that do it.
  while (end <= lastOfMonth.getTime()) end = addDays(end, 7);
  return { start, end };
}

/** Every day-start in a range, in order. */
export function daysIn(range: { start: number; end: number }): number[] {
  const out: number[] = [];
  for (let t = range.start; t < range.end; t = addDays(t, 1)) out.push(t);
  return out;
}

/** Where Previous / Next land. A month step moves by a calendar month rather
 *  than by 28–31 days, so paging forward and back returns where it started. */
export function shiftAnchor(anchor: number, scale: CalendarScale, steps: number): number {
  if (scale === "week") return addDays(anchor, 7 * steps);
  const d = new Date(startOfMonth(anchor));
  return new Date(d.getFullYear(), d.getMonth() + steps, 1).getTime();
}

/** `YYYY-MM-DD` in the VIEWER's timezone — what the anchor rides in the URL as,
 *  so a shared link opens the week the sender was looking at. */
export function anchorParam(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Reads an anchor back, falling back to today for anything unparseable — a
 *  hand-edited URL should show this week, not an error. */
export function parseAnchor(v: string | null, now = Date.now()): number {
  if (!v) return startOfDay(now);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return startOfDay(now);
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isNaN(t) ? startOfDay(now) : t;
}

/** "1 – 7 Sep 2026", "31 Aug – 6 Sep 2026", "September 2026". Built from
 *  Intl so it follows the viewer's locale rather than a fixed order. */
export function rangeLabel(anchor: number, scale: CalendarScale): string {
  if (scale === "month") {
    return new Date(startOfMonth(anchor)).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
  }
  const { start, end } = gridRangeOf(anchor, "week");
  const last = new Date(addDays(end, -1));
  const first = new Date(start);
  const sameMonth = first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear();
  const sameYear = first.getFullYear() === last.getFullYear();
  const from = first.toLocaleDateString(undefined, {
    day: "numeric",
    month: sameMonth ? undefined : "short",
    year: sameYear ? undefined : "numeric",
  });
  const to = last.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return `${from} – ${to}`;
}

/** The two lines a day column heading carries: "Tue" and "1 Sep". */
export function dayColumnLabel(t: number): { weekday: string; date: string } {
  const d = new Date(t);
  return {
    weekday: d.toLocaleDateString(undefined, { weekday: "short" }),
    date: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
  };
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

// ─────────────────────────────────────────────────────────────────────────────
// Where a meeting sits
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The span a call occupies on a calendar.
 *
 * `end` prefers the ACTUAL end, falls back to the PLANNED end, and is otherwise
 * the start — a call with neither (a "meet now" still running, or one whose
 * organiser chose "no end time") is a point in time, and inventing a duration
 * for it would draw a block nobody scheduled. The grid gives such a call a
 * readable minimum height instead, which is a rendering decision and lives
 * there rather than here.
 */
export function occurrenceOf(call: CallDTO): { start: number; end: number } {
  const start = whenOf(call);
  const endIso = call.endedAt || call.endsAt;
  const end = endIso ? new Date(endIso).getTime() : start;
  return { start, end: Math.max(start, end) };
}

/** Does this call touch this day at all? Overlap, not containment — a meeting
 *  running past midnight belongs to both days it is in.
 *
 *  An end landing exactly ON midnight belongs to the day it ended and not to
 *  the next one, which would otherwise open with a meeting of zero length. A
 *  call with no duration at all still belongs to the day it starts on. */
export function occursOn(call: CallDTO, dayStart: number): boolean {
  const { start, end } = occurrenceOf(call);
  const dayEnd = addDays(dayStart, 1);
  if (start >= dayEnd) return false;
  return end > dayStart || start >= dayStart;
}

/** The smallest block that can still hold a time and a title. A 10-minute
 *  meeting drawn to scale is an unreadable sliver. */
const MIN_BLOCK_MINUTES = 26;

/** The hours the grid shows. 9 AM to 6 PM is the working day the reference
 *  design asks for — the last labelled row is 5 PM, with the hour after it to
 *  land in. */
export const DEFAULT_DAY_START_HOUR = 9;
export const DEFAULT_DAY_END_HOUR = 18;

/** The epoch ms of wall-clock `hour` on `day` (itself a local midnight) — via
 *  `setHours` rather than a flat `hour * 3_600_000` offset, so a DST
 *  transition day (23 or 25 real hours) still lines up with the row it is
 *  labelled with. `hour` may be 24, which rolls over to the following
 *  midnight exactly as `addDays(day, 1)` would. */
function hourAt(day: number, hour: number): number {
  const d = new Date(day);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** The wall-clock hour a moment within `day` sits at, fractional so a half
 *  hour still lands between two rows — via Date's own local fields rather
 *  than dividing the elapsed ms by a flat 3,600,000, for the same DST reason
 *  as `hourAt`. A moment exactly on the following midnight reads as 24,
 *  matching what `hourAt(day, 24)` would draw it against. */
function hourOfDay(t: number, day: number): number {
  if (t >= addDays(day, 1)) return 24;
  const d = new Date(t);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600 + d.getMilliseconds() / 3_600_000;
}

/**
 * The hour window wide enough to show every meeting handed to it.
 *
 * The default working day is the LOOK; it is not a filter. A 7 AM stand-up
 * clamped out of a 9-to-6 grid would be a meeting that silently does not
 * exist — so the window opens to include whatever is actually there and stays
 * at the default when nothing needs it to.
 */
export function hourWindowFor(
  calls: readonly CallDTO[],
  days: readonly number[],
): { startHour: number; endHour: number } {
  let startHour = DEFAULT_DAY_START_HOUR;
  let endHour = DEFAULT_DAY_END_HOUR;

  // Per DAY, against each day's own slice of the meeting. Two things go wrong
  // when this is measured against the meeting as a whole:
  //
  //   • a meeting on Thursday would widen the grid by its distance from
  //     Monday midnight rather than by its own hours; and
  //   • a meeting from 23:30 to 00:30 would widen NEITHER day — its start hour
  //     is on one day and its end hour on the next — and would then be clipped
  //     out of both by layOutDay, which is a meeting that silently does not
  //     exist.
  //
  // Measured against the block's DRAWN extent for the same reason layOutDay
  // draws a minimum: an instant-in-time meeting at 23:50 has no end hour to
  // widen by, and would fall off the bottom of an unwidened grid.
  for (const day of days) {
    const dayEnd = addDays(day, 1);
    for (const call of calls) {
      const { start, end } = occurrenceOf(call);
      if (start >= dayEnd || (end <= day && start < day)) continue;
      const from = Math.max(start, day);
      const to = Math.min(Math.max(end, start + MIN_BLOCK_MINUTES * 60_000), dayEnd);
      if (to <= from) continue;
      startHour = Math.min(startHour, Math.floor(hourOfDay(from, day)));
      // An end exactly on the hour needs no extra row; 17:30 needs the 18 line.
      endHour = Math.max(endHour, Math.ceil(hourOfDay(to, day)));
    }
  }
  return { startHour: Math.max(0, startHour), endHour: Math.min(24, Math.max(endHour, startHour + 1)) };
}

/** The hour lines to label, e.g. [9, 10, … 17] for a 9→18 window. */
export function hourRows(win: { startHour: number; endHour: number }): number[] {
  const out: number[] = [];
  for (let h = win.startHour; h < win.endHour; h++) out.push(h);
  return out;
}

/** One meeting placed on one day column, in percentages of the grid box so the
 *  grid can be any height the window gives it. */
export interface PositionedCall {
  call: CallDTO;
  /** The clock times of THIS day's slice, already clipped to the day. */
  start: number;
  end: number;
  topPct: number;
  heightPct: number;
  /** Which of `columns` side-by-side lanes this block takes, for overlaps. */
  column: number;
  columns: number;
}

/**
 * Place one day's meetings.
 *
 * Two jobs: clip each call to the visible hours of THIS day (a meeting running
 * past midnight is drawn on both days, each showing its own slice), and lay
 * overlapping meetings out side by side rather than on top of one another.
 *
 * The packing is the standard greedy one: walk the day in start order, and give
 * each meeting the first lane whose last occupant has finished. A run of
 * mutually overlapping meetings shares a lane count, so two meetings at the
 * same time are each half-width and four are each a quarter — the width is a
 * fact about the clash, not a fixed guess.
 */
export function layOutDay(
  calls: readonly CallDTO[],
  dayStart: number,
  win: { startHour: number; endHour: number },
): PositionedCall[] {
  const winStart = hourAt(dayStart, win.startHour);
  const winEnd = hourAt(dayStart, win.endHour);
  const span = winEnd - winStart;
  if (span <= 0) return [];
  const minMs = MIN_BLOCK_MINUTES * 60_000;

  const slices = calls
    .map((call) => {
      const o = occurrenceOf(call);
      const start = Math.max(o.start, winStart);
      // A call with no end at all still gets a readable block.
      const rawEnd = Math.max(o.end, o.start + minMs);
      return { call, start, end: Math.min(rawEnd, winEnd) };
    })
    .filter((s) => s.end > winStart && s.start < winEnd)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  // Lane assignment, then a second pass for the lane COUNT: a meeting's width
  // depends on how many lanes its cluster ended up needing, which is not known
  // until the cluster is closed.
  const laneEnds: number[] = [];
  const placed: { slice: (typeof slices)[number]; column: number; cluster: number }[] = [];
  let cluster = 0;
  let clusterEnd = -Infinity;

  for (const slice of slices) {
    // Drawn height, not real height, decides whether two blocks visually clash.
    const drawnEnd = Math.max(slice.end, slice.start + minMs);
    if (slice.start >= clusterEnd) {
      cluster++;
      laneEnds.length = 0;
      clusterEnd = -Infinity;
    }
    let column = laneEnds.findIndex((e) => e <= slice.start);
    if (column === -1) column = laneEnds.length;
    laneEnds[column] = drawnEnd;
    clusterEnd = Math.max(clusterEnd, drawnEnd);
    placed.push({ slice, column, cluster });
  }

  const widthOf = new Map<number, number>();
  for (const p of placed) {
    widthOf.set(p.cluster, Math.max(widthOf.get(p.cluster) ?? 1, p.column + 1));
  }

  return placed.map(({ slice, column, cluster }) => {
    const top = ((slice.start - winStart) / span) * 100;
    const height = ((Math.max(slice.end, slice.start + minMs) - slice.start) / span) * 100;
    return {
      call: slice.call,
      start: slice.start,
      end: slice.end,
      topPct: Math.max(0, Math.min(100, top)),
      heightPct: Math.max(0, Math.min(100 - Math.max(0, top), height)),
      column,
      columns: widthOf.get(cluster) ?? 1,
    };
  });
}

/** Where the "now" line goes in a day column, or null when now is outside the
 *  visible hours (or outside this day entirely). */
export function nowLinePct(
  dayStart: number,
  win: { startHour: number; endHour: number },
  now = Date.now(),
): number | null {
  if (!isSameDay(now, dayStart)) return null;
  const winStart = hourAt(dayStart, win.startHour);
  const span = hourAt(dayStart, win.endHour) - winStart;
  const pct = ((now - winStart) / span) * 100;
  return pct < 0 || pct > 100 ? null : pct;
}
