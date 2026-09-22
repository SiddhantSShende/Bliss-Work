import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { daysIn, gridRangeOf, isSameDay, rangeLabel, shiftAnchor, startOfMonth } from "../lib/meetingCalendar";
import { startOfDay } from "../lib/dayLabel";

/**
 * A compact month grid that doubles as a date filter: days holding tasks carry
 * a dot, and picking a day selects it (picking it again clears it). The date
 * math is the Meetings calendar's own; only the cells are new, because the
 * meeting grid draws chips at a size a sidebar-width calendar can't hold.
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
  const [anchor, setAnchor] = useState(() => startOfMonth(Date.now()));
  const days = daysIn(gridRangeOf(anchor, "month"));
  const month = new Date(anchor).getMonth();
  const today = startOfDay(Date.now());

  return (
    <div className="w-full max-w-xs">
      <div className="mb-2 flex items-center justify-between">
        <StepButton label="Previous month" onClick={() => setAnchor(shiftAnchor(anchor, "month", -1))}>
          <ChevronLeft size={16} />
        </StepButton>
        <span className="text-sm font-medium text-fg">{rangeLabel(anchor, "month")}</span>
        <StepButton label="Next month" onClick={() => setAnchor(shiftAnchor(anchor, "month", 1))}>
          <ChevronRight size={16} />
        </StepButton>
      </div>
      <div className="grid grid-cols-7 text-center text-[10px] font-medium uppercase text-muted">
        {days.slice(0, 7).map((d) => (
          <span key={d} className="py-1">
            {new Date(d).toLocaleDateString(undefined, { weekday: "narrow" })}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5">
        {days.map((day) => {
          const selected = selectedDay !== null && isSameDay(day, selectedDay);
          const tone = selected
            ? "bg-accent text-accent-fg"
            : new Date(day).getMonth() === month
              ? "text-fg hover:bg-surface-2"
              : "text-muted/60 hover:bg-surface-2";
          return (
            <button
              key={day}
              type="button"
              aria-pressed={selected}
              aria-label={new Date(day).toLocaleDateString(undefined, { dateStyle: "full" })}
              onClick={() => onSelectDay(selected ? null : day)}
              className={`relative mx-auto flex h-8 w-8 items-center justify-center rounded-full text-xs transition-colors ${tone} ${
                day === today && !selected ? "ring-1 ring-accent" : ""
              }`}
            >
              {new Date(day).getDate()}
              {markedDays.has(day) && (
                <span
                  data-testid="task-day-mark"
                  className={`absolute bottom-0.5 h-1 w-1 rounded-full ${selected ? "bg-accent-fg" : "bg-accent"}`}
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
      className="px-2 py-1 text-muted transition-colors hover:text-accent"
    >
      {children}
    </button>
  );
}
