import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Clock, ChevronDown } from "lucide-react";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import { usePopoverPosition } from "../lib/usePopoverPosition";
import i18n from "../i18n";

/** 12 at the top, then clockwise — the order a real clock face reads in, so
 *  `pointOn`'s index-based angle lines each value up with its usual position. */
const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
/** Same idea for minutes, in fives — a round analog dial has room for twelve
 *  marks, not sixty, same as any wall clock's minute hand landing on one of
 *  the hour marks. */
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55] as const;

const FACE = 200;
const RADIUS = 78;
const CENTER = FACE / 2;

/** "light" is the meeting form's own hardcoded white card (see NewMeetingDialog's
 *  doc comment); "theme" follows the user's chosen theme, like the rest of the
 *  app — for a caller whose surrounding form is NOT a white card (CreateTaskDialog's
 *  Modal, in particular). The accent (hand, selected number, AM/PM on-state, the
 *  OK button) is already theme-following in both, same as everywhere else this
 *  distinction shows up (see pickerTone.ts). */
export type TimePickerTone = "light" | "theme";

const TIME_PICKER_TONES: Record<TimePickerTone, {
  trigger: string;
  chevron: string;
  panel: string;
  readoutActive: string;
  readoutInactive: string;
  colon: string;
  periodBorder: string;
  periodOff: string;
  face: string;
  numberOff: string;
  cancelBtn: string;
}> = {
  light: {
    trigger: "border-gray-300 bg-white text-gray-900",
    chevron: "text-gray-400",
    panel: "border-gray-200 bg-white shadow-lg",
    readoutActive: "bg-accent/10 text-accent",
    readoutInactive: "text-gray-900",
    colon: "text-gray-300",
    periodBorder: "border-gray-300",
    periodOff: "text-gray-500 hover:bg-gray-50",
    face: "#F3F4F6",
    numberOff: "text-gray-700 hover:bg-white",
    cancelBtn: "text-gray-600 hover:bg-gray-100",
  },
  theme: {
    trigger: "border-border bg-surface-2 text-fg",
    chevron: "text-muted",
    panel: "border-border bg-surface shadow-card",
    readoutActive: "bg-accent-soft text-accent",
    readoutInactive: "text-fg",
    colon: "text-muted/50",
    periodBorder: "border-border",
    periodOff: "text-muted hover:bg-surface-2",
    face: "var(--color-surface-2)",
    numberOff: "text-fg hover:bg-surface",
    cancelBtn: "text-muted hover:bg-surface-2",
  },
};

/** Where the `index`-th of `count` evenly-spaced marks sits on the dial —
 *  index 0 at 12 o'clock, going clockwise. */
function pointOn(index: number, count: number): { x: number; y: number } {
  const angle = (index / count) * 2 * Math.PI - Math.PI / 2;
  return { x: CENTER + RADIUS * Math.cos(angle), y: CENTER + RADIUS * Math.sin(angle) };
}

function parse(value: string): { h: number; m: number } {
  const [hh, mm] = value.split(":").map(Number);
  return {
    h: typeof hh === "number" && Number.isFinite(hh) ? hh : 0,
    m: typeof mm === "number" && Number.isFinite(mm) ? mm : 0,
  };
}
function format(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function to12(h: number): { hour12: number; period: "AM" | "PM" } {
  return { hour12: h % 12 === 0 ? 12 : h % 12, period: h < 12 ? "AM" : "PM" };
}
function to24(hour12: number, period: "AM" | "PM"): number {
  const h = hour12 % 12;
  return period === "PM" ? h + 12 : h;
}
/** Locale-formatted, for the trigger's own display — the dial inside the
 *  popover is deliberately always 12-hour (an analog face has no other way to
 *  read), but the closed field should still read the way every other time in
 *  this app does. */
function displayValue(value: string): string {
  const { h, m } = parse(value);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(i18n.language, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A reusable round/analog clock, replacing the native time input for both the
 * meeting form's Start and End Time fields.
 *
 * Trigger keeps the same chrome the native input had (icon, chevron, focus
 * ring) so swapping it in doesn't change the form's rhythm. Opening it copies
 * `value` into local draft state — hour, minute, AM/PM — so picking a new
 * hour or minute only ever changes the DRAFT; nothing reaches `onChange`
 * until OK. Cancel, Escape, or a click outside (usePopupDismiss, same as
 * EmojiPicker) just closes, discarding the draft and leaving `value` exactly
 * as it was.
 *
 * Portalled to document.body and positioned with usePopoverPosition for the
 * same reason as EmojiPicker's own popup: MeetingDialogShell's card scrolls
 * on a short window, and a panel placed inside it would be clipped the
 * moment that happens.
 */
export function TimePicker({
  label,
  value,
  onChange,
  tone = "light",
  minTime,
}: {
  /** The field's own label ("Start Time" / "End Time") — composed into the
   *  trigger's accessible name, same convention the native input used. */
  label: string;
  /** 24-hour "HH:mm". */
  value: string;
  onChange: (next: string) => void;
  tone?: TimePickerTone;
  /** 24-hour "HH:mm": earlier times are disabled on the dial. */
  minTime?: string;
}) {
  const { t } = useTranslation("meetings");
  const c = TIME_PICKER_TONES[tone];
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"hour" | "minute">("hour");
  const [hour12, setHour12] = useState(12);
  const [minute, setMinute] = useState(0);
  const [period, setPeriod] = useState<"AM" | "PM">("AM");
  const panelRef = useRef<HTMLDivElement>(null);

  const cancel = () => setOpen(false);
  const wrap = usePopupDismiss<HTMLDivElement>(open, cancel, [panelRef]);
  const style = usePopoverPosition({ anchor: wrap, panelRef, active: open });

  const openPicker = () => {
    const { h, m } = parse(value);
    const t12 = to12(h);
    setHour12(t12.hour12);
    setPeriod(t12.period);
    setMinute(m);
    setMode("hour");
    setOpen(true);
  };

  const minTotal = minTime ? parse(minTime).h * 60 + parse(minTime).m : 0;
  const draftTotal = to24(hour12, period) * 60 + minute;
  const draftTooEarly = draftTotal < minTotal;
  const periodDisabled = (p: "AM" | "PM") => (p === "AM" ? 12 * 60 : 24 * 60) <= minTotal;
  const optionDisabled = (v: number) =>
    mode === "hour"
      ? to24(v, period) * 60 + 59 < minTotal
      : to24(hour12, period) * 60 + v < minTotal;

  const confirm = () => {
    if (draftTooEarly) return;
    onChange(format(to24(hour12, period), minute));
    setOpen(false);
  };

  const pick = (v: number) => {
    if (mode === "hour") {
      setHour12(v);
      setMode("minute");
    } else {
      setMinute(v);
    }
  };

  const values: readonly number[] = mode === "hour" ? HOURS : MINUTES;
  const selected = mode === "hour" ? hour12 : minute;
  const handTarget = pointOn(values.indexOf(selected), values.length);

  return (
    <div ref={wrap} className="relative">
      <Clock size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-accent" />
      <button
        type="button"
        aria-label={t("newMeeting.time.triggerAriaLabel", { label })}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => (open ? cancel() : openPicker())}
        className={`w-full rounded-lg border py-2 pl-9 pr-7 text-left text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent ${c.trigger}`}
      >
        {displayValue(value)}
      </button>
      <ChevronDown
        size={14}
        className={`pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 ${c.chevron}`}
      />

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="group"
            aria-label={t("newMeeting.time.pickerAriaLabel", { label })}
            style={style}
            className={`fixed z-[1100] w-64 rounded-2xl border p-4 ${c.panel}`}
          >
            <div className="mb-3 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => setMode("hour")}
                aria-label={t("newMeeting.time.chooseHour")}
                className={`rounded-md px-1.5 py-0.5 text-2xl font-semibold tabular-nums ${
                  mode === "hour" ? c.readoutActive : c.readoutInactive
                }`}
              >
                {String(hour12).padStart(2, "0")}
              </button>
              <span className={`text-2xl font-semibold ${c.colon}`}>:</span>
              <button
                type="button"
                onClick={() => setMode("minute")}
                aria-label={t("newMeeting.time.chooseMinutes")}
                className={`rounded-md px-1.5 py-0.5 text-2xl font-semibold tabular-nums ${
                  mode === "minute" ? c.readoutActive : c.readoutInactive
                }`}
              >
                {String(minute).padStart(2, "0")}
              </button>
              <div className={`ml-1 flex flex-col overflow-hidden rounded-md border text-[10px] font-semibold ${c.periodBorder}`}>
                <button
                  type="button"
                  aria-pressed={period === "AM"}
                  disabled={periodDisabled("AM")}
                  onClick={() => setPeriod("AM")}
                  className={`px-1.5 py-0.5 disabled:cursor-not-allowed disabled:opacity-40 ${period === "AM" ? "bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg" : c.periodOff}`}
                >
                  {t("newMeeting.time.am")}
                </button>
                <button
                  type="button"
                  aria-pressed={period === "PM"}
                  disabled={periodDisabled("PM")}
                  onClick={() => setPeriod("PM")}
                  className={`px-1.5 py-0.5 disabled:cursor-not-allowed disabled:opacity-40 ${period === "PM" ? "bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg" : c.periodOff}`}
                >
                  {t("newMeeting.time.pm")}
                </button>
              </div>
            </div>

            <div className="relative mx-auto" style={{ width: FACE, height: FACE }}>
              <svg width={FACE} height={FACE} className="absolute inset-0" aria-hidden>
                <circle cx={CENTER} cy={CENTER} r={RADIUS + 22} fill={c.face} />
                <line
                  x1={CENTER}
                  y1={CENTER}
                  x2={handTarget.x}
                  y2={handTarget.y}
                  stroke="var(--color-accent)"
                  strokeWidth={2}
                />
                <circle cx={CENTER} cy={CENTER} r={3} fill="var(--color-accent)" />
              </svg>
              {values.map((v, i) => {
                const p = pointOn(i, values.length);
                const isSelected = v === selected;
                return (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={
                      mode === "hour"
                        ? t("newMeeting.time.hourAria", { hour: v })
                        : t("newMeeting.time.minuteAria", { minute: String(v).padStart(2, "0") })
                    }
                    onClick={() => pick(v)}
                    disabled={optionDisabled(v)}
                    style={{ left: p.x, top: p.y, transform: "translate(-50%, -50%)" }}
                    className={`absolute flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                      isSelected
                        ? "bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg"
                        : c.numberOff
                    }`}
                  >
                    {mode === "hour" ? v : String(v).padStart(2, "0")}
                  </button>
                );
              })}
            </div>

            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancel}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${c.cancelBtn}`}
              >
                {t("newMeeting.time.cancel")}
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={draftTooEarly}
                className="rounded-lg bg-gradient-to-br from-brand-from via-brand-mid to-brand-to px-3 py-1.5 text-sm font-medium text-accent-fg transition hover:brightness-105 disabled:opacity-40"
              >
                {t("newMeeting.time.ok")}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
