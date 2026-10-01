import { AlarmClockOff, CalendarClock, Hourglass } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatTaskInstant } from "../lib/taskDates";

/**
 * The compact "when" rows of a task card: when it was assigned, when it is due
 * (only if it has a deadline — no empty placeholder otherwise) and, once the
 * deadline passed unmet, when it was missed.
 *
 * Chips wrap onto further lines and each may break inside its own text, so a
 * narrow card or a large browser zoom grows the card instead of pushing a chip
 * out of it. `shrink-0` on the row is for the floating desktop note, whose card
 * is height-capped: the description absorbs a shortfall, never these.
 */
export function TaskTimes({
  assignedAt,
  deadlineAt,
  missedAt,
  className = "",
}: {
  assignedAt?: string | null;
  deadlineAt?: string | null;
  missedAt?: string | null;
  className?: string;
}) {
  const { t } = useTranslation("stickies");
  const assigned = formatTaskInstant(assignedAt);
  const deadline = formatTaskInstant(deadlineAt);
  const missed = formatTaskInstant(missedAt);
  if (!assigned && !deadline && !missed) return null;
  return (
    <div className={`flex min-w-0 shrink-0 flex-wrap gap-1.5 ${className}`} data-testid="task-times">
      {assigned && <TimeChip icon={CalendarClock} label={t("card.assigned")} iso={assignedAt!} value={assigned} />}
      {deadline && <TimeChip icon={Hourglass} label={t("card.deadline")} iso={deadlineAt!} value={deadline} />}
      {missed && <TimeChip icon={AlarmClockOff} label={t("card.missedOn")} iso={missedAt!} value={missed} tone="danger" />}
    </div>
  );
}

function TimeChip({
  icon: Icon,
  label,
  iso,
  value,
  tone = "neutral",
}: {
  icon: typeof CalendarClock;
  label: string;
  iso: string;
  value: string;
  tone?: "neutral" | "danger";
}) {
  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-start gap-1 rounded-lg px-2 py-1 text-xs leading-snug ${
        tone === "danger" ? "bg-danger/12 text-danger" : "bg-surface-2 text-muted"
      }`}
    >
      <Icon size={13} aria-hidden className="mt-px shrink-0" />
      {/* [overflow-wrap:anywhere] is the last resort inside a chip only: the chip
          itself is a flex item that can shrink below its text, so a date in a very
          narrow card breaks rather than overflowing the card. */}
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className={tone === "danger" ? "" : "text-fg/70"}>{label}</span>{" "}
        <time dateTime={iso} className={tone === "danger" ? "font-medium" : "font-medium text-fg"}>
          {value}
        </time>
      </span>
    </span>
  );
}
