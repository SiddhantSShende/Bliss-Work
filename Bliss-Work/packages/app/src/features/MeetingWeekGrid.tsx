/**
 * The week calendar: a time gutter, seven day columns, and every meeting drawn
 * at the hours it actually runs.
 *
 * Every position on screen comes from lib/meetingCalendar — `hourWindowFor`
 * decides which hours are visible, `layOutDay` turns a day's meetings into
 * percentages, and this file does nothing but render them. Nothing here knows a
 * date, an hour or a pixel offset for a particular meeting.
 *
 * ── Colour ───────────────────────────────────────────────────────────────────
 * The grid is white (`bg-surface`), the columns are white, and the theme colour
 * appears only as an ACCENT: a block's left edge and tint, today's column
 * heading, the now line. Live meetings borrow the semantic success colour and
 * cancelled ones the muted one, which are states rather than branding — the
 * same rule the meeting badges already follow.
 */
import { useTranslation } from "react-i18next";
import type { CallDTO } from "@taskboard/shared";
import { Phone, Video } from "lucide-react";
import { timeLabel } from "../lib/meetingTime";
import { meetingBucketOrPast, meetingScope, meetingTitle } from "../lib/meetingView";
import {
  dayColumnLabel,
  hourRows,
  isSameDay,
  layOutDay,
  nowLinePct,
  occursOn,
  type PositionedCall,
} from "../lib/meetingCalendar";

/** How tall one hour is. The grid scrolls inside its own box rather than
 *  stretching the page, so this is a real height and not a fraction. */
const HOUR_HEIGHT_REM = 3.5;

/** Hour labels are 1rem tall and centred on the line they name, so a label sits
 *  this far above its line. The label for the window's END line (12 AM after
 *  11 PM) has no row of its own, so the scroll body gets this much tail below
 *  that line — enough to show the label, not an extra hour. */
const LABEL_LIFT_REM = 0.5;

export function MeetingWeekGrid({
  days,
  calls,
  window: win,
  now,
  onOpen,
  nameOf,
}: {
  days: readonly number[];
  calls: readonly CallDTO[];
  window: { startHour: number; endHour: number };
  now: number;
  onOpen: (call: CallDTO) => void;
  nameOf: (id: string) => string;
}) {
  const { i18n } = useTranslation("meetings");
  const hours = hourRows(win);
  const bodyHeight = `${hours.length * HOUR_HEIGHT_REM}rem`;

  return (
    // Two nested scrollers on purpose: the OUTER one scrolls sideways when the
    // window is too narrow for seven readable columns, and the inner one
    // scrolls the hours. Neither ever grows the page — see the page shell.
    <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
      <div className="flex h-full min-w-[52rem] flex-col">
        <div className="flex shrink-0 border-b border-border/70">
          <div className="w-14 shrink-0" aria-hidden />
          {days.map((day) => (
            <DayHeading key={day} day={day} today={isSameDay(day, now)} />
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex" style={{ height: bodyHeight }}>
            <div className="relative w-14 shrink-0">
              {hours.map((h, index) => (
                <div
                  key={h}
                  className="relative border-b border-transparent"
                  style={{ height: `${HOUR_HEIGHT_REM}rem` }}
                >
                  {/* Lifted onto the line it labels rather than sitting inside
                      the hour below it, which is what makes a block starting at
                      10:00 line up with the "10 AM" it is next to. The very
                      first row has no row above it to lift into — scrolled to
                      the top, that negative offset pushes the label above the
                      scroll container's own edge and clips it (whichever hour
                      the window happens to start at, e.g. 12 AM). So the first
                      row's label sits flush at its own top instead. */}
                  <span
                    className={`absolute right-2 text-[11px] font-medium text-muted ${
                      index === 0 ? "top-0" : "-top-2"
                    }`}
                  >
                    {hourLabel(h, i18n.language)}
                  </span>
                </div>
              ))}
              <span
                className="absolute right-2 text-[11px] font-medium leading-4 text-muted"
                style={{ top: `calc(100% - ${LABEL_LIFT_REM}rem)` }}
              >
                {hourLabel(win.endHour % 24, i18n.language)}
              </span>
            </div>

            {days.map((day) => (
              <DayColumn
                key={day}
                day={day}
                hours={hours}
                positioned={layOutDay(calls.filter((c) => occursOn(c, day)), day, win)}
                nowPct={nowLinePct(day, win, now)}
                onOpen={onOpen}
                nameOf={nameOf}
              />
            ))}
          </div>
          <div aria-hidden style={{ height: `${LABEL_LIFT_REM}rem` }} />
        </div>
      </div>
    </div>
  );
}

function hourLabel(hour: number, locale: string): string {
  // Through Intl so a 24-hour locale gets "13:00" rather than a forced "1 PM".
  return new Date(2000, 0, 1, hour).toLocaleTimeString(locale, { hour: "numeric" });
}

function DayHeading({ day, today }: { day: number; today: boolean }) {
  const { weekday, date } = dayColumnLabel(day);
  return (
    <div className="min-w-0 flex-1 border-l border-border/60 px-2 py-2 text-center">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{weekday}</div>
      <div
        className={
          today
            ? "mx-auto mt-0.5 inline-flex items-center rounded-full bg-gradient-to-br from-brand-from via-brand-mid to-brand-to px-2 py-0.5 text-xs font-semibold text-accent-fg"
            : "mt-0.5 text-xs font-semibold text-fg"
        }
      >
        {date}
      </div>
    </div>
  );
}

function DayColumn({
  day,
  hours,
  positioned,
  nowPct,
  onOpen,
  nameOf,
}: {
  day: number;
  hours: readonly number[];
  positioned: PositionedCall[];
  nowPct: number | null;
  onOpen: (call: CallDTO) => void;
  nameOf: (id: string) => string;
}) {
  return (
    <div className="relative min-w-0 flex-1 border-l border-border/60">
      {hours.map((h) => (
        <div key={h} className="border-b border-border/40" style={{ height: `${HOUR_HEIGHT_REM}rem` }} />
      ))}

      {nowPct !== null && (
        <div
          className="pointer-events-none absolute inset-x-0 z-20 flex items-center"
          style={{ top: `${nowPct}%` }}
          aria-hidden
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
          <span className="h-px flex-1 bg-danger" />
        </div>
      )}

      {positioned.map((p) => (
        <MeetingBlock key={`${p.call.id}-${day}`} placed={p} onOpen={onOpen} nameOf={nameOf} />
      ))}
    </div>
  );
}

/** Tone per state. Accent for what is coming, success for what is happening,
 *  muted for what is done — the same three the list badges use, so a meeting
 *  reads the same in both places. */
const BLOCK_TONE: Record<string, string> = {
  upcoming: "border-l-accent bg-accent-soft text-fg hover:bg-accent/15",
  live: "border-l-success bg-success/10 text-fg hover:bg-success/15",
  past: "border-l-border bg-surface-2 text-muted hover:bg-surface-2/70",
};

function MeetingBlock({
  placed,
  onOpen,
  nameOf,
}: {
  placed: PositionedCall;
  onOpen: (call: CallDTO) => void;
  nameOf: (id: string) => string;
}) {
  const { call, topPct, heightPct, column, columns } = placed;
  const bucket = meetingBucketOrPast(call);
  const Icon = call.media === "audio" ? Phone : Video;
  const title = meetingTitle(call, nameOf);
  // The team this meeting belongs to, when it belongs to one at all — a channel
  // call has a channel, a meeting has only its own roster.
  const scope = meetingScope(call);
  const short = heightPct < 6;

  return (
    <button
      type="button"
      onClick={() => onOpen(call)}
      title={`${timeLabel(placed.start)} – ${timeLabel(placed.end)} · ${title}`}
      style={{
        top: `${topPct}%`,
        height: `${heightPct}%`,
        left: `calc(${(column / columns) * 100}% + 2px)`,
        width: `calc(${100 / columns}% - 4px)`,
      }}
      className={`absolute z-10 overflow-hidden rounded-md border border-border/60 border-l-[3px] px-1.5 py-1 text-left transition-colors ${
        BLOCK_TONE[bucket] ?? BLOCK_TONE.past
      } ${call.status === "CANCELLED" ? "line-through decoration-1" : ""}`}
    >
      <span className="flex items-center gap-1 text-[10px] font-medium leading-tight opacity-80">
        <Icon size={10} className="shrink-0" aria-hidden />
        <span className="truncate">
          {timeLabel(placed.start)}
          {placed.end > placed.start ? ` – ${timeLabel(placed.end)}` : ""}
        </span>
      </span>
      {!short && (
        <>
          <span className="mt-0.5 block truncate text-[11px] font-semibold leading-tight">
            {title}
          </span>
          {scope && heightPct >= 10 && (
            <span className="block truncate text-[10px] leading-tight opacity-70">{scope}</span>
          )}
        </>
      )}
    </button>
  );
}
