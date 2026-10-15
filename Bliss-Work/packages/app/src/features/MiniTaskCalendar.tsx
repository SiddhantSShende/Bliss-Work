import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { daysIn, gridRangeOf, isSameDay, rangeLabel, shiftAnchor, startOfMonth } from "../lib/meetingCalendar";
import { startOfDay } from "../lib/dayLabel";

/**
 * A month grid that doubles as a date filter: days holding tasks carry a dot,
 * and picking a day selects it (picking it again clears it). It fills whatever
 * box it is given — the rows share the height — so beside the filters panel it
 * is as tall as that panel. The date math is the Meetings calendar's own; only
 * the cells are new, because the meeting grid draws chips too big for these.
 */
export function MiniTaskCalendar({
  markedDays,
  selectedDay,
  onSelectDay,
}: {
  markedDays: ReadonlySet<number>;
  selectedDay: number | null;
  onSelectDay: (day: number | null) => void;
}) {
  const { t, i18n } = useTranslation("tasks");
  const [anchor, setAnchor] = useState(() => startOfMonth(Date.now()));
  const days = daysIn(gridRangeOf(anchor, "month"));
  const month = new Date(anchor).getMonth();
  const today = startOfDay(Date.now());

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-fg">{rangeLabel(anchor, "month")}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setAnchor(startOfMonth(Date.now()))}
            className="rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-fg transition-colors hover:bg-surface-2/70"
          >
            {t("miniTaskCalendar.today")}
          </button>
          <StepButton label={t("miniTaskCalendar.previousMonth")} onClick={() => setAnchor(shiftAnchor(anchor, "month", -1))}>
            <ChevronLeft size={16} />
          </StepButton>
          <StepButton label={t("miniTaskCalendar.nextMonth")} onClick={() => setAnchor(shiftAnchor(anchor, "month", 1))}>
            <ChevronRight size={16} />
          </StepButton>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] font-medium uppercase text-muted">
        {days.slice(0, 7).map((d) => (
          <span key={d} className="py-1">
            {new Date(d).toLocaleDateString(i18n.language, { weekday: "short" })}
          </span>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-7 gap-y-0.5">
        {days.map((day) => {
          const selected = selectedDay !== null && isSameDay(day, selectedDay);
          const tone = selected
            ? "bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg"
            : new Date(day).getMonth() === month
              ? "text-fg hover:bg-surface-2"
              : "text-muted/60 hover:bg-surface-2";
          return (
            <button
              key={day}
              type="button"
              aria-pressed={selected}
              aria-label={new Date(day).toLocaleDateString(i18n.language, { dateStyle: "full" })}
              onClick={() => onSelectDay(selected ? null : day)}
              className={`relative m-auto flex h-9 w-9 items-center justify-center rounded-full text-sm transition-colors ${tone} ${
                day === today && !selected ? "ring-1 ring-accent" : ""
              }`}
            >
              {new Date(day).getDate()}
              {markedDays.has(day) && (
                <span
                  data-testid="task-day-mark"
                  className={`absolute bottom-1 h-1.5 w-1.5 rounded-full ${selected ? "bg-accent-fg" : "bg-accent"}`}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StepButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-full p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-accent"
    >
      {children}
    </button>
  );
}
