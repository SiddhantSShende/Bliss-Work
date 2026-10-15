import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Calendar, Video } from "lucide-react";
import { useTheme } from "@taskboard/ui";
import { ApiError, type CallDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useToggleSet } from "../lib/useToggleSet";
import {
  browserTimeZone,
  describeRecurrenceForm,
  emptyRecurrence,
  toRecurrenceInput,
  validateRecurrence,
  type RecurrenceForm,
} from "../lib/meetingRecurrence";
import { MeetingAddSection } from "./MeetingAddSection";
import { MeetingDialogShell } from "./MeetingDialogShell";
import { MeetingPreview } from "./MeetingPreview";
import { MeetingRepeatField } from "./MeetingRepeatField";
import { MeetingScheduledDialog } from "./MeetingScheduledDialog";
import { MEETING_TONES } from "./meetingTone";
import type { PickerTone } from "./pickerTone";
import { TimePicker } from "./TimePicker";

/** How long the meeting runs when scheduled, in minutes — matches the
 *  server's own default (defaultCallMinutes in calls.go), same reasoning as
 *  ScheduleCallDialog's DEFAULT_MINUTES. Duplicated rather than imported:
 *  this component no longer shares any state shape with that one (see the
 *  file's own doc comment), so importing a single unrelated constant across
 *  files isn't worth the coupling. */
const DEFAULT_MEETING_MINUTES = 60;

/** Ordinary clock skew and the gap between picking a time and clicking
 *  submit, not a real past date — mirrors ScheduleCallDialog's own
 *  SCHEDULE_GRACE_MS and the server's scheduleGraceWindow (calls.go), kept
 *  in step so this client never rejects a value the server would accept, or
 *  the reverse. Also the "start now" vs. a real future schedule boundary
 *  the request itself is decided by (see `scheduled` below): the Start Time
 *  fields default to right now, so without this grace window the ordinary
 *  few seconds between opening the popup and clicking submit would send a
 *  future `scheduledAt` for a start time the user never touched. */
const GRACE_MS = 60_000;

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function localTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** `date` ("YYYY-MM-DD") + `time` ("HH:mm") -> a local Date, or null while
 *  either half is empty/unparseable (native date/time inputs can be cleared
 *  to "" by the user). No timezone suffix on the combined string is
 *  deliberate — same as datetime-local elsewhere in this codebase, that
 *  makes JS parse it in the viewer's own timezone, which is what someone
 *  picking a wall-clock time means. */
function combine(date: string, time: string): Date | null {
  if (!date || !time) return null;
  const d = new Date(`${date}T${time}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `startAt` + the meeting's default length — what End resets to whenever
 *  Start changes. Native Date arithmetic on the epoch-ms value (not string
 *  math on the date/time fields separately), so a start near midnight rolls
 *  the date half forward on its own: 23:30 -> 00:30 the next day, with
 *  nothing here needing to special-case the rollover. */
function plusDefaultDuration(startAt: Date): { date: string; time: string } {
  const end = new Date(startAt.getTime() + DEFAULT_MEETING_MINUTES * 60_000);
  return { date: localDate(end), time: localTime(end) };
}

interface FormErrors {
  title?: string;
  start?: string;
  end?: string;
  /** Nobody and no channel added. */
  audience?: string;
}

/** Pure so it can run on every render — the Cancel/submit row never has to
 *  guess whether it's stale. `attempted`-gating the DISPLAY of these lives in
 *  the component; this always returns the true current answer. */
function validate(
  t: TFunction,
  title: string,
  startAt: Date | null,
  endAt: Date | null,
  /** The Start Time is still the value the form opened with, i.e. "now". */
  startsNow: boolean,
  /** How many people plus channels have been added. */
  audienceSize: number,
): FormErrors {
  const errors: FormErrors = {};
  if (!title.trim()) errors.title = t("newMeeting.errors.titleRequired");
  if (audienceSize === 0) errors.audience = t("newMeeting.errors.audienceRequired");

  if (!startAt) errors.start = t("newMeeting.errors.startRequired");
  // The default Start Time is the minute the popup OPENED at, so it drifts into
  // the past the longer the popup sits there. Only a time the user picked can be
  // "in the past"; an untouched one means now, whenever they press the button.
  else if (!startsNow && startAt.getTime() < Date.now() - GRACE_MS) {
    errors.start = t("newMeeting.errors.startInPast");
  }

  if (!endAt) errors.end = t("newMeeting.errors.endRequired");
  else if (startAt && endAt.getTime() <= (startsNow ? Date.now() : startAt.getTime())) {
    errors.end = t("newMeeting.errors.endBeforeStart");
  }

  return errors;
}

/**
 * The "New Meeting" popup — a compact, predominantly WHITE corporate card
 * (per the product's reference design) rather than the app's usual
 * dark-mode-adaptive surface: everything here is intentionally hardcoded
 * white/gray/dark-text — `bg-white`, `border-gray-200`, `text-gray-900` —
 * NOT `bg-surface`/`text-fg`, which would flip to a dark card in dark mode.
 * In dark mode the same card is painted with the app's surface tokens instead (the
 * "theme" tone, meetingTone.ts — what the New Task modal uses), so it is not a white
 * slab on a dark app; light mode keeps the white above, class for class.
 * The one place that still follows the user's chosen theme in light is the accent —
 * the submit button, the field icons, and focus rings all use the existing
 * `accent`/`accent-fg` tokens (ScheduleCallDialog.tsx's chosen accent
 * variety), so switching theme in Settings still recolors this popup's one
 * highlight the same way it does everywhere else.
 *
 * A dedicated component rather than a new branch of ScheduleCallDialog: this
 * popup's layout (two independently-labeled date+time fields per row,
 * always-populated start defaulting to now, a Meeting Preview, a
 * confirmation step of its own — MeetingInviteLink is still what the
 * meeting's own detail page uses afterwards) is different enough from the
 * channel/direct scopes' shared shell that folding it in as another
 * `scope.kind === "meeting"` conditional would have made that file harder to
 * follow for a design that has nothing left in common with theirs.
 * ScheduleCallDialog.tsx no longer has a "meeting" scope at all — this
 * replaced it there.
 *
 * Still the SAME backend call as before: api.scheduleMeeting, invalidating
 * qk.calls so Upcoming/Live/Past + the Meetings rail badge update without a
 * refresh — see queryBridge.tsx's handling of the resulting call.* events.
 *
 * ── Confirmation, not an immediate redirect ──────────────────────────────────
 * The submit button always reads "Schedule Meeting", whatever `scheduled`
 * below works out to be for the REQUEST (that still decides `scheduledAt`
 * and `durationMinutes`, exactly as before). Once `create` succeeds, this
 * renders MeetingScheduledDialog in place of the form rather than closing —
 * onClose/onStarted only fire from THAT dialog's own buttons, so a "Start
 * Now" meeting no longer jumps straight into the room; the confirmation is
 * always in between, with Start Meeting Now as its own explicit action.
 *
 * ── Add (people + channels), repeat ──────────────────────────────────────────
 * Add says who is invited — people, and channels (every member of a channel is
 * invited) — and is required: a meeting needs at least one of the two. Both lists are
 * paged from the server (MeetingAddSection), never loaded whole. Repeat makes this the
 * first of a series. All of it rides the same request. A REPEATING meeting is always
 * scheduled, never "start now": there is nothing to repeat from otherwise, so choosing
 * Repeat also turns off the "an untouched start time means now" allowance and holds
 * the start to the same not-in-the-past rule a chosen time gets.
 *
 * ── End follows Start, until it is set by hand ───────────────────────────────
 * End opens at Start + 1 hour and keeps that distance while Start moves. The first time
 * the user sets End themselves it stops following, and their End stands.
 */
export function NewMeetingDialog({
  onClose,
  onStarted,
  onViewInCalendar,
}: {
  onClose: () => void;
  /** Fired from the confirmation's Start Meeting Now, so the caller can open
   *  the meeting right away. */
  onStarted?: (call: CallDTO) => void;
  /** Fired from the confirmation's View in Calendar. */
  onViewInCalendar?: (call: CallDTO) => void;
}) {
  const { t } = useTranslation("meetings");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const { isDark } = useTheme();
  const tone: PickerTone = isDark ? "theme" : "light";
  const c = MEETING_TONES[tone];

  const [title, setTitle] = useState("");
  const [startDate, setStartDate] = useState(() => localDate(new Date()));
  const [startTime, setStartTime] = useState(() => localTime(new Date()));
  // Both halves from the SAME plusDefaultDuration(now) call, not independent
  // localDate(now)/localTime(now + 1h): computing the date half from `now`
  // while the time half already carries the +1h offset used to leave them
  // mismatched whenever "now" was near midnight — opening at 23:30 produced
  // TODAY's date with a "00:30" time, i.e. an End an hour BEFORE Start rather
  // than an hour after it.
  const [endDate, setEndDate] = useState(() => plusDefaultDuration(new Date()).date);
  const [endTime, setEndTime] = useState(() => plusDefaultDuration(new Date()).time);
  const invitees = useToggleSet();
  const channels = useToggleSet();
  const [recurrence, setRecurrence] = useState<RecurrenceForm>(emptyRecurrence);
  /** Set on the first submit attempt, so validation messages appear once the
   *  user has tried to go rather than nagging them before they've typed
   *  anything — same convention as the rest of the app's forms. */
  const [attempted, setAttempted] = useState(false);
  /** Whether the user has changed the Start Time from its "right now" default. */
  const [startEdited, setStartEdited] = useState(false);
  /** Whether the user has set the End Time themselves. Until then End simply
   *  follows Start (+1 hour); once they have, moving Start leaves their End alone. */
  const [endEdited, setEndEdited] = useState(false);
  /** Set once `create` succeeds — swaps the form for MeetingScheduledDialog.
   *  See the component doc comment's "Confirmation, not an immediate
   *  redirect". */
  const [scheduledCall, setScheduledCall] = useState<CallDTO | null>(null);
  /** The clock, re-read twice a minute so the primary button's label and the
   *  past-start check follow real time while the popup sits open. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  // Names for the Meeting Preview (and, after success, the confirmation's recap of
  // the same thing). The Add section only ever holds a page of the organisation at a
  // time, so a pick's name is recorded here the moment it is made: the preview and
  // the confirmation keep naming people and channels that have since scrolled out of
  // (or been searched out of) the loaded pages.
  const pickedPeople = useRef(new Map<string, string>());
  const pickedChannels = useRef(new Map<string, string>());
  const togglePerson = (id: string, name: string) => {
    pickedPeople.current.set(id, name);
    invitees.toggle(id);
  };
  const toggleChannel = (id: string, name: string) => {
    pickedChannels.current.set(id, name);
    channels.toggle(id);
  };
  const inviteeNames = useMemo(
    () => [...invitees.selected].map((id) => pickedPeople.current.get(id) || t("newMeeting.unknownMember")),
    [invitees.selected, t],
  );
  const channelNames = useMemo(
    () => [...channels.selected].map((id) => pickedChannels.current.get(id) || t("newMeeting.unknownChannel")),
    [channels.selected, t],
  );

  /** Start changed (either half) -> End follows to Start + the default length, unless
   *  the user has set End themselves, in which case their End stands (and the usual
   *  "End is before Start" check tells them if the move has left it unusable). Called
   *  from the Start field's own handlers rather than an effect watching startAt: those
   *  two are the only real sources of a Start change, so it needs no loop guard and
   *  cannot mistake a plain re-render for an edit. */
  const resetEndAfterStartChange = (nextStartDate: string, nextStartTime: string) => {
    if (endEdited) return;
    const nextStart = combine(nextStartDate, nextStartTime);
    if (!nextStart) return;
    const end = plusDefaultDuration(nextStart);
    setEndDate(end.date);
    setEndTime(end.time);
  };

  const repeating = recurrence.repeat !== "NONE";
  const startAt = useMemo(() => combine(startDate, startTime), [startDate, startTime]);
  const endAt = useMemo(() => combine(endDate, endTime), [endDate, endTime]);
  const audienceSize = invitees.selected.size + channels.selected.size;
  const errors = validate(t, title, startAt, endAt, !startEdited && !repeating, audienceSize);
  const recurrenceErrors = validateRecurrence(t, recurrence, startDate);
  const hasErrors = Object.keys(errors).length > 0 || Object.keys(recurrenceErrors).length > 0;

  /** A start time meaningfully ahead of now — as opposed to "now" itself,
   *  including the ordinary few seconds of clock skew between opening this
   *  popup (which defaults Start Time to the current moment) and clicking
   *  submit. With Repeat it does not matter: a repeating meeting is scheduled
   *  either way. This alone decides what is actually sent to the server —
   *  `scheduledAt` present or omitted — the button itself no longer varies
   *  by it. */
  const isFuture = startEdited && !!startAt && startAt.getTime() - now > GRACE_MS;
  const scheduled = isFuture || repeating;
  /** A picked start that has slipped into the past: shown at once and blocks
   *  the primary action, rather than waiting for a submit attempt. */
  const startInPast = errors.start === t("newMeeting.errors.startInPast");
  const today = localDate(new Date(now));
  const sameDayAsStart = endDate === startDate;

  const create = useMutation({
    mutationFn: (vars: { startAt: Date; endAt: Date; scheduled: boolean }) =>
      api.scheduleMeeting({
        title: title.trim(),
        media: "video",
        scheduledAt: vars.scheduled ? vars.startAt.toISOString() : undefined,
        // Only meaningful for a real future schedule — "start now" has no
        // fixed end the server needs to know about up front, same as
        // ScheduleCallDialog's own "no start time at all -> omit
        // durationMinutes too" reasoning.
        durationMinutes: vars.scheduled
          ? Math.round((vars.endAt.getTime() - vars.startAt.getTime()) / 60_000)
          : undefined,
        // Left out when empty, so a plain meeting's request is exactly what it
        // always was.
        inviteeIds: invitees.selected.size ? [...invitees.selected] : undefined,
        channelIds: channels.selected.size ? [...channels.selected] : undefined,
        recurrence: toRecurrenceInput(recurrence, startDate, browserTimeZone()),
      }),
    onSuccess: (call, vars) => {
      void qc.invalidateQueries({ queryKey: qk.calls });
      // Start now goes straight into the meeting; only a scheduled one gets
      // the confirmation.
      if (!vars.scheduled) {
        onStarted?.(call);
        onClose();
        return;
      }
      setScheduledCall(call);
    },
    // 403 is the server's one answer for a member who is gone, a channel that is
    // gone or that the organiser is not in, and a block: say what to do about it.
    onError: (err) =>
      toast.error(
        err instanceof ApiError && err.status === 403
          ? t("newMeeting.errors.peopleUnavailable")
          : t("newMeeting.scheduleError"),
      ),
  });

  const submit = () => {
    // A double click, or Enter while a request is in flight, must not schedule
    // the meeting twice.
    if (create.isPending) return;
    // Decided NOW, not read from the last render: whether a start is "in the
    // past" depends on the clock, and a popup left open with nothing touched has
    // not re-rendered since the time it was validated at.
    const stale = Object.keys(validate(t, title, startAt, endAt, !startEdited && !repeating, audienceSize)).length > 0;
    if (stale || hasErrors || !startAt || !endAt) {
      setAttempted(true);
      return;
    }
    create.mutate({ startAt, endAt, scheduled });
  };

  if (scheduledCall && startAt && endAt) {
    return (
      <MeetingScheduledDialog
        call={scheduledCall}
        title={title}
        startAt={startAt}
        endAt={endAt}
        inviteeNames={inviteeNames}
        channelNames={channelNames}
        onClose={onClose}
        onStarted={onStarted}
        onViewInCalendar={onViewInCalendar}
      />
    );
  }

  // Pinned bottom-right of the dialog, below both columns.
  const footer = (
    <>
      <button
        type="button"
        onClick={onClose}
        className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${c.cancel}`}
      >
        {t("newMeeting.cancel")}
      </button>
      <button
        type="button"
        onClick={submit}
        disabled={create.isPending || startInPast}
        className="flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-from via-brand-mid to-brand-to px-4 py-2 text-sm font-semibold text-accent-fg shadow-sm transition hover:brightness-105 disabled:opacity-60"
      >
        <Video size={15} />
        {scheduled
          ? create.isPending
            ? t("newMeeting.scheduling")
            : t("newMeeting.scheduleMeeting")
          : create.isPending
            ? t("newMeeting.starting")
            : t("newMeeting.startMeeting")}
      </button>
    </>
  );

  return (
    <MeetingDialogShell
      title={t("newMeeting.title")}
      closeLabel={t("newMeeting.close")}
      onClose={onClose}
      footer={footer}
      wide
      tone={tone}
    >
      {/* Two columns from md up. Left, what is being scheduled and who is asked:
          title, start, end, then Add (People / Channels). Right: the live preview, and
          Repeat beneath it. One column below md, in that same order. grid-cols-1
          matters: without it the single mobile column is an implicit auto track that
          grows to fit its widest content, so a long name pushed the whole form past
          the dialog's edge. The Add lists have a fixed height and scroll inside
          themselves, so the dialog is the same height with ten people or ten thousand. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,11fr)_minmax(0,10fr)] md:items-start md:gap-6">
        <div className="flex min-w-0 flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className={`text-sm font-medium ${c.label}`}>{t("newMeeting.titleLabel")}</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("newMeeting.titlePlaceholder")}
              maxLength={200}
              className={`w-full rounded-lg border px-3 py-2 text-sm outline-none ${c.control}`}
            />
            {attempted && errors.title && <span className="text-xs text-danger">{errors.title}</span>}
          </label>

          <DateTimeFields
            label={t("newMeeting.startTimeLabel")}
            date={startDate}
            time={startTime}
            onDateChange={(v) => {
              setStartEdited(true);
              setStartDate(v);
              resetEndAfterStartChange(v, startTime);
            }}
            onTimeChange={(v) => {
              setStartEdited(true);
              setStartTime(v);
              resetEndAfterStartChange(startDate, v);
            }}
            error={attempted || startInPast ? errors.start : undefined}
            minDate={today}
            minTime={startDate === today ? localTime(new Date(now)) : undefined}
            tone={tone}
          />

          <DateTimeFields
            label={t("newMeeting.endTimeLabel")}
            date={endDate}
            time={endTime}
            onDateChange={(v) => {
              setEndEdited(true);
              setEndDate(v);
            }}
            onTimeChange={(v) => {
              setEndEdited(true);
              setEndTime(v);
            }}
            error={attempted ? errors.end : undefined}
            minDate={startDate}
            minTime={sameDayAsStart ? startTime : undefined}
            tone={tone}
          />

          <MeetingAddSection
            invitees={invitees.selected}
            onTogglePerson={togglePerson}
            channels={channels.selected}
            onToggleChannel={toggleChannel}
            error={attempted ? errors.audience : undefined}
            tone={tone}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <MeetingPreview
            layout="card"
            title={title}
            startAt={startAt}
            endAt={endAt}
            inviteeNames={inviteeNames}
            channelNames={channelNames}
            repeat={describeRecurrenceForm(t, recurrence, startDate)}
            tone={tone}
          />
          <MeetingRepeatField
            value={recurrence}
            onChange={setRecurrence}
            startDate={startDate}
            errors={attempted ? recurrenceErrors : undefined}
            tone={tone}
          />
        </div>
      </div>
    </MeetingDialogShell>
  );
}

function DateTimeFields({
  label,
  date,
  time,
  onDateChange,
  onTimeChange,
  error,
  minDate,
  minTime,
  tone,
}: {
  label: string;
  date: string;
  time: string;
  onDateChange: (v: string) => void;
  onTimeChange: (v: string) => void;
  error?: string;
  minDate?: string;
  minTime?: string;
  tone: PickerTone;
}) {
  const { t } = useTranslation("meetings");
  const c = MEETING_TONES[tone];
  return (
    <div className="flex flex-col gap-1.5">
      <span className={`text-sm font-medium ${c.label}`}>{label}</span>
      <div className="grid grid-cols-2 gap-2">
        <div className="relative">
          <Calendar
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-accent"
          />
          <input
            type="date"
            aria-label={t("newMeeting.time.dateAriaLabel", { label })}
            value={date}
            min={minDate}
            onChange={(e) => onDateChange(e.target.value)}
            className={`w-full rounded-lg border py-2 pl-9 pr-2 text-sm outline-none max-[420px]:pl-8 max-[420px]:pr-1 ${c.control}`}
          />
        </div>
        <TimePicker label={label} value={time} onChange={onTimeChange} minTime={minTime} tone={tone} />
      </div>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
