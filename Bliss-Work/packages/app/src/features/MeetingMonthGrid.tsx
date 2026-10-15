/**
 * The month view: whole weeks of day cells, each listing the meetings that fall
 * on it.
 *
 * Deliberately NOT the week grid at a smaller scale. A month cell is about two
 * centimetres tall; drawing a 30-minute meeting to scale inside one produces a
 * mark too small to read and too small to click. So a month says WHICH days
 * have meetings and what they are called, and the week view — one click away on
 * the same toggle — says when.
 *
 * Days outside the anchored month are still drawn, greyed: a week is a week,
 * and blanking the days either side leaves a meeting on the 31st looking like
 * it has no neighbours.
 */
import { useTranslation } from "react-i18next";
import type { CallDTO } from "@taskboard/shared";
import { timeLabel } from "../lib/meetingTime";
import { meetingBucketOrPast, meetingTitle } from "../lib/meetingView";
import { isSameDay, occurrenceOf, occursOn, startOfMonth } from "../lib/meetingCalendar";

/** Meetings listed in a cell before the rest become "+N more". Enough to see a
 *  busy day is busy without a cell that scrolls. */
const CHIPS_PER_DAY = 3;

const CHIP_TONE: Record<string, string> = {
  upcoming: "bg-accent-soft text-accent hover:bg-accent/20",
  live: "bg-success/12 text-success hover:bg-success/20",
  past: "bg-surface-2 text-muted hover:bg-surface-2/70",
};

export function MeetingMonthGrid({
  days,
  calls,
  anchor,
  now,
  onOpen,
  onPickDay,
  nameOf,
}: {
  days: readonly number[];
  calls: readonly CallDTO[];
  anchor: number;
  now: number;
  onOpen: (call: CallDTO) => void;
  /** Clicking a day's date opens that week — the month's job is to point at
   *  the day, the week's is to say when. */
  onPickDay: (day: number) => void;
  nameOf: (id: string) => string;
}) {
  const { i18n } = useTranslation("meetings");
  const month = new Date(startOfMonth(anchor)).getMonth();
  const weekdayNames = days.slice(0, 7).map((d) =>
    new Date(d).toLocaleDateString(i18n.language, { weekday: "short" }),
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="min-w-[44rem]">
        <div className="grid grid-cols-7 border-b border-border/70">
          {weekdayNames.map((name) => (
            <div
              key={name}
              className="px-2 py-2 text-center text-[11px] font-medium uppercase tracking-wide text-muted"
            >
              {name}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day) => (
            <DayCell
              key={day}
              day={day}
              inMonth={new Date(day).getMonth() === month}
              today={isSameDay(day, now)}
              calls={calls.filter((c) => occursOn(c, day))}
              onOpen={onOpen}
              onPickDay={onPickDay}
              nameOf={nameOf}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayCell({
  day,
  inMonth,
  today,
  calls,
  onOpen,
  onPickDay,
  nameOf,
}: {
  day: number;
  inMonth: boolean;
  today: boolean;
  calls: CallDTO[];
  onOpen: (call: CallDTO) => void;
  onPickDay: (day: number) => void;
  nameOf: (id: string) => string;
}) {
  const { t } = useTranslation("meetings");
  const ordered = [...calls].sort((a, b) => occurrenceOf(a).start - occurrenceOf(b).start);
  const shown = ordered.slice(0, CHIPS_PER_DAY);
  const hidden = ordered.length - shown.length;

  return (
    <div
      className={`min-h-[6.5rem] border-b border-l border-border/50 p-1.5 ${
        inMonth ? "bg-surface" : "bg-surface-2/40"
      }`}
    >
      <button
        type="button"
        onClick={() => onPickDay(day)}
        title={t("monthGrid.openThisWeek")}
        className={`mb-1 flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-semibold transition-colors ${
          today
            ? "bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg"
            : inMonth
              ? "text-fg hover:bg-surface-2"
              : "text-muted hover:bg-surface-2"
        }`}
      >
        {new Date(day).getDate()}
      </button>

      <div className="space-y-0.5">
        {shown.map((call) => {
          const bucket = meetingBucketOrPast(call);
          const title = meetingTitle(call, nameOf);
          return (
            <button
              key={call.id}
              type="button"
              onClick={() => onOpen(call)}
              title={`${timeLabel(occurrenceOf(call).start)} · ${title}`}
              className={`flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[10px] font-medium transition-colors ${
                CHIP_TONE[bucket] ?? CHIP_TONE.past
              } ${call.status === "CANCELLED" ? "line-through" : ""}`}
            >
              <span className="shrink-0 tabular-nums opacity-80">
                {timeLabel(occurrenceOf(call).start)}
              </span>
              <span className="truncate">{title}</span>
            </button>
          );
        })}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => onPickDay(day)}
            className="px-1 text-[10px] font-semibold text-muted hover:text-accent"
          >
            {t("monthGrid.more", { count: hidden })}
          </button>
        )}
      </div>
    </div>
  );
}
