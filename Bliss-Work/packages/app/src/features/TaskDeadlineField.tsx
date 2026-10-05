import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@taskboard/ui";
import {
  kindsFor,
  effectiveKind,
  type Allocation,
  type DeadlineForm,
  type DeadlineKind,
  type DeadlineUnit,
} from "../lib/taskDeadline";
import { Field } from "../routes/Onboarding";
import { TimePicker } from "./TimePicker";

const selectClass = "rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-fg";
const UNITS: DeadlineUnit[] = ["MINUTES", "HOURS", "DAYS"];

/**
 * The optional Deadline of the New task form, placed in the existing form using its
 * own controls (a native select like the monthly rule's, the date Input, the analog
 * TimePicker). What it offers follows the allocation — see lib/taskDeadline.
 *
 *   Now / Schedule for later   [ No deadline ▼ ]  →  [ Date & time ▼ ]  date · time
 *   Recurring                  [ No deadline | Relative | Fixed time ▼ ]
 *                              Relative: [ 6 ] [ Hours ▼ ] after each occurrence
 *                              Fixed:    [ 5:00 PM ] on each occurrence's date
 *
 * Wraps rather than overflowing in a narrow dialog.
 */
export function TaskDeadlineField({
  allocation,
  value,
  onChange,
  startDate,
  startTime,
}: {
  allocation: Allocation;
  value: DeadlineForm;
  onChange: (next: DeadlineForm) => void;
  /** The allocation's start, when it has one — bounds what the pickers offer. */
  startDate: string;
  startTime: string;
}) {
  const { t } = useTranslation("tasks");
  const kindId = useId();
  const kind = effectiveKind(value, allocation);
  const set = (patch: Partial<DeadlineForm>) => onChange({ ...value, ...patch });
  const kindLabel: Record<DeadlineKind, string> = {
    NONE: t("createTaskDialog.deadline.none"),
    AT: t("createTaskDialog.deadline.at"),
    RELATIVE: t("createTaskDialog.deadline.relative"),
    FIXED: t("createTaskDialog.deadline.fixed"),
  };
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="deadline-field">
      <label htmlFor={kindId} className="text-[13px] font-medium text-fg/80">
        {t("createTaskDialog.deadline.label")}
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <select
          id={kindId}
          className={selectClass}
          value={kind}
          onChange={(e) => set({ kind: e.target.value as DeadlineKind })}
        >
          {kindsFor(allocation).map((k) => (
            <option key={k} value={k}>
              {kindLabel[k]}
            </option>
          ))}
        </select>

        {kind === "RELATIVE" && (
          <>
            <Input
              className="w-20"
              type="number"
              min={1}
              inputMode="numeric"
              aria-label={t("createTaskDialog.deadline.amount")}
              value={value.amount}
              onChange={(e) => set({ amount: e.target.value })}
            />
            <select
              className={selectClass}
              aria-label={t("createTaskDialog.deadline.unit")}
              value={value.unit}
              onChange={(e) => set({ unit: e.target.value as DeadlineUnit })}
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`createTaskDialog.deadline.units.${u}`)}
                </option>
              ))}
            </select>
            <span className="min-w-0 text-sm text-muted">{t("createTaskDialog.deadline.afterEach")}</span>
          </>
        )}

        {kind === "FIXED" && (
          <>
            <div className="w-40 max-w-full">
              <TimePicker
                tone="theme"
                label={t("createTaskDialog.deadline.fixedTime")}
                value={value.fixedTime}
                onChange={(fixedTime) => set({ fixedTime })}
                minTime={startTime || undefined}
              />
            </div>
            <span className="min-w-0 text-sm text-muted">{t("createTaskDialog.deadline.onEachDate")}</span>
          </>
        )}
      </div>

      {kind === "AT" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("createTaskDialog.deadline.date")}>
            <Input
              type="date"
              value={value.date}
              min={allocation === "SCHEDULED" && startDate ? startDate : todayIso}
              onChange={(e) => set({ date: e.target.value })}
            />
          </Field>
          <Field label={t("createTaskDialog.deadline.time")}>
            <TimePicker
              tone="theme"
              label={t("createTaskDialog.deadline.time")}
              value={value.time}
              onChange={(time) => set({ time })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
