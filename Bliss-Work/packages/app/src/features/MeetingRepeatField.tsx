import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { RecurrenceEndCondition } from "@taskboard/shared";
import {
  MAX_INTERVAL,
  MAX_OCCURRENCES,
  effectiveWeekdays,
  toggleWeekday,
  unitLabel,
  weekdayName,
  type RecurrenceErrors,
  type RecurrenceForm,
  type RepeatKind,
} from "../lib/meetingRecurrence";
import { MEETING_TONES } from "./meetingTone";
import type { PickerTone } from "./pickerTone";

/** The same control chrome as the title input in NewMeetingDialog; the colours come
 *  from the tone (see meetingTone.ts). */
const CONTROL = "rounded-lg border px-3 py-2 text-sm outline-none";

const REPEAT_OPTIONS: readonly { value: RepeatKind; key: string }[] = [
  { value: "NONE", key: "none" },
  { value: "DAILY", key: "daily" },
  { value: "WEEKLY", key: "weekly" },
  { value: "MONTHLY", key: "monthly" },
];

const END_OPTIONS: readonly { value: RecurrenceEndCondition; key: string }[] = [
  { value: "NO_END", key: "endNever" },
  { value: "ON_DATE", key: "endOnDate" },
  { value: "AFTER_OCCURRENCES", key: "endAfter" },
];

/** Monday first: the API's weekday 0, and the week "every 2 weeks" counts in. */
const WEEK = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * "Repeat" for the meeting form: how often, on which days, and when it stops.
 *
 * Controlled — the caller owns the form (see lib/meetingRecurrence) and its
 * validation, and passes `errors` only once it wants them shown, the same
 * convention as the form's other fields.
 *
 * `startDate` (YYYY-MM-DD) is what weekly's default day follows and what an end
 * date may not precede.
 */
export function MeetingRepeatField({
  value,
  onChange,
  startDate,
  errors,
  allowNone = true,
  tone = "light",
}: {
  value: RecurrenceForm;
  onChange: (next: RecurrenceForm) => void;
  startDate: string;
  errors?: RecurrenceErrors;
  /** Offer "Does not repeat". Off when editing a series, where not repeating is
   *  spelled "cancel the series" and is its own, confirmed action. */
  allowNone?: boolean;
  /** "theme" paints it with the app's surface tokens (NewMeetingDialog, dark mode). */
  tone?: PickerTone;
}) {
  const { t } = useTranslation("meetings");
  const ids = { repeat: useId(), ends: useId() };
  const c = MEETING_TONES[tone];
  const control = `${CONTROL} ${c.control}`;
  const set = (patch: Partial<RecurrenceForm>) => onChange({ ...value, ...patch });
  const repeating = value.repeat !== "NONE";
  const interval = Number(value.interval);
  const days = new Set(effectiveWeekdays(value, startDate));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.repeat} className={`text-sm font-medium ${c.label}`}>
          {t("newMeeting.repeat.label")}
        </label>
        <select
          id={ids.repeat}
          value={value.repeat}
          onChange={(e) => set({ repeat: e.target.value as RepeatKind })}
          className={control}
        >
          {REPEAT_OPTIONS.filter((o) => allowNone || o.value !== "NONE").map((o) => (
            <option key={o.value} value={o.value}>
              {t(`newMeeting.repeat.${o.key}`)}
            </option>
          ))}
        </select>
      </div>

      {repeating && (
        <>
          <div className="flex flex-col gap-1.5">
            <div className={`flex items-center gap-2 text-sm ${c.body}`}>
              <span className="font-medium">{t("newMeeting.repeat.every")}</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_INTERVAL}
                value={value.interval}
                onChange={(e) => set({ interval: e.target.value })}
                aria-label={t("newMeeting.repeat.intervalAria")}
                aria-invalid={!!errors?.interval}
                className={`${control} w-20`}
              />
              <span>
                {unitLabel(t, value.repeat as Exclude<RepeatKind, "NONE">, Number.isFinite(interval) ? interval : 1)}
              </span>
            </div>
            {errors?.interval && <span className="text-xs text-danger">{errors.interval}</span>}
          </div>

          {value.repeat === "MONTHLY" && startDate && (
            // "Monthly" is the same day of the month as the first meeting, and a
            // month that lacks it (the 31st) is skipped rather than shifted. Said
            // here, because nothing else on the form would tell you.
            <p className={`text-xs ${c.muted}`}>
              {t("newMeeting.repeat.monthlyHint", { day: Number(startDate.slice(8, 10)) })}
            </p>
          )}

          {value.repeat === "WEEKLY" && (
            <div className="flex flex-col gap-1.5">
              <span id={`${ids.repeat}-on`} className={`text-sm font-medium ${c.label}`}>
                {t("newMeeting.repeat.on")}
              </span>
              {/* A named group of toggles. The visible text is one letter, which is
                  ambiguous (two T, two S) and unreadable to a screen reader, so each
                  button carries the full weekday as its name. */}
              <div role="group" aria-labelledby={`${ids.repeat}-on`} className="flex flex-wrap gap-1.5">
                {WEEK.map((d) => {
                  const on = days.has(d);
                  const name = weekdayName(d, "long");
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      aria-label={name}
                      title={name}
                      onClick={() => onChange(toggleWeekday(value, startDate, d))}
                      className={`h-9 w-9 rounded-full text-xs font-semibold uppercase transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                        on
                          ? "bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg"
                          : `border ${c.dayOff}`
                      }`}
                    >
                      {weekdayName(d, "narrow")}
                    </button>
                  );
                })}
              </div>
              {errors?.weekdays && <span className="text-xs text-danger">{errors.weekdays}</span>}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.ends} className={`text-sm font-medium ${c.label}`}>
              {t("newMeeting.repeat.ends")}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                id={ids.ends}
                value={value.endCondition}
                onChange={(e) => set({ endCondition: e.target.value as RecurrenceEndCondition })}
                className={control}
              >
                {END_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(`newMeeting.repeat.${o.key}`)}
                  </option>
                ))}
              </select>
              {value.endCondition === "ON_DATE" && (
                <input
                  type="date"
                  min={startDate || undefined}
                  value={value.endDate}
                  onChange={(e) => set({ endDate: e.target.value })}
                  aria-label={t("newMeeting.repeat.endDateAria")}
                  aria-invalid={!!errors?.endDate}
                  className={control}
                />
              )}
              {value.endCondition === "AFTER_OCCURRENCES" && (
                <span className={`flex items-center gap-2 text-sm ${c.body}`}>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={MAX_OCCURRENCES}
                    value={value.occurrenceCount}
                    onChange={(e) => set({ occurrenceCount: e.target.value })}
                    aria-label={t("newMeeting.repeat.occurrenceCountAria")}
                    aria-invalid={!!errors?.occurrenceCount}
                    className={`${control} w-24`}
                  />
                  {t("newMeeting.repeat.occurrences", { count: Number(value.occurrenceCount) || 0 })}
                </span>
              )}
            </div>
            {errors?.endDate && <span className="text-xs text-danger">{errors.endDate}</span>}
            {errors?.occurrenceCount && (
              <span className="text-xs text-danger">{errors.occurrenceCount}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
