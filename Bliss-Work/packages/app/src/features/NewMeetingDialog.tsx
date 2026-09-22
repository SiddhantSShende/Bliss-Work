import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Calendar, ChevronDown, Clock, Video, X } from "lucide-react";
import type { CallDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useDialogBehavior } from "./Modal";

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
 *  the reverse. Doubles as the Start Now / Schedule boundary: the Start Time
 *  fields default to right now, so without this grace window the ordinary
 *  few seconds between opening the popup and clicking submit would make the
 *  button read "Schedule" for a start time the user never touched. */
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

interface FormErrors {
  title?: string;
  start?: string;
  end?: string;
}

/** Pure so it can run on every render — the Cancel/submit row never has to
 *  guess whether it's stale. `attempted`-gating the DISPLAY of these lives in
 *  the component; this always returns the true current answer. */
function validate(
  title: string,
  startAt: Date | null,
  endAt: Date | null,
  /** The Start Time is still the value the form opened with, i.e. "now". */
  startsNow: boolean,
): FormErrors {
  const errors: FormErrors = {};
  if (!title.trim()) errors.title = "Meeting title is required.";

  if (!startAt) errors.start = "Start date and time are required.";
  // The default Start Time is the minute the popup OPENED at, so it drifts into
  // the past the longer the popup sits there. Only a time the user picked can be
  // "in the past"; an untouched one means now, whenever they press the button.
  else if (!startsNow && startAt.getTime() < Date.now() - GRACE_MS) {
    errors.start = "Start time can't be in the past.";
  }

  if (!endAt) errors.end = "End date and time are required.";
  else if (startAt && endAt.getTime() <= (startsNow ? Date.now() : startAt.getTime())) {
    errors.end = "End time must be later than the start time.";
  }

  return errors;
}

/**
 * The "New Meeting" popup — redesigned to a compact, predominantly WHITE
 * corporate card (per the product's reference design) rather than the app's
 * usual dark-mode-adaptive surface. See STEP 9 of the task this shipped
 * with: everything here is intentionally hardcoded white/gray/dark-text —
 * `bg-white`, `border-gray-200`, `text-gray-900` — NOT `bg-surface`/
 * `text-fg`, which would flip to a dark card in dark mode. The one place
 * that still follows the user's chosen theme is the accent — the Start Now
 * / Schedule button, the field icons, and focus rings all use the existing
 * `accent`/`accent-fg` tokens (ScheduleCallDialog.tsx's chosen accent
 * variety), so switching theme in Settings still recolors this popup's one
 * highlight the same way it does everywhere else.
 *
 * A dedicated component rather than a new branch of ScheduleCallDialog: this
 * popup's layout (two independently-labeled date+time fields per row,
 * always-populated start defaulting to now, no post-create invite-link
 * step — that's still available from the meeting's own detail page via
 * MeetingInviteLink) is different enough from the channel/direct scopes'
 * shared shell that folding it in as another `scope.kind === "meeting"`
 * conditional would have made that file harder to follow for a design that
 * has nothing left in common with theirs. ScheduleCallDialog.tsx no longer
 * has a "meeting" scope at all — this replaced it there.
 *
 * Still the SAME backend call as before: api.scheduleMeeting, invalidating
 * qk.calls so Upcoming/Live/Past + the Meetings rail badge update without a
 * refresh — see queryBridge.tsx's handling of the resulting call.* events.
 */
export function NewMeetingDialog({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  /** Fired when the meeting starts immediately (Start Now) so the caller can
   *  open it right away. NOT fired for a future Schedule — nothing to join
   *  yet. */
  onStarted?: (call: CallDTO) => void;
}) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const panelRef = useDialogBehavior(true, onClose);

  const [title, setTitle] = useState("");
  const [startDate, setStartDate] = useState(() => localDate(new Date()));
  const [startTime, setStartTime] = useState(() => localTime(new Date()));
  const [endDate, setEndDate] = useState(() => localDate(new Date()));
  const [endTime, setEndTime] = useState(() =>
    localTime(new Date(Date.now() + DEFAULT_MEETING_MINUTES * 60_000)),
  );
  /** Set on the first submit attempt, so validation messages appear once the
   *  user has tried to go rather than nagging them before they've typed
   *  anything — same convention as the rest of the app's forms. */
  const [attempted, setAttempted] = useState(false);
  /** Whether the user has changed the Start Time from its "right now" default. */
  const [startEdited, setStartEdited] = useState(false);

  const startAt = useMemo(() => combine(startDate, startTime), [startDate, startTime]);
  const endAt = useMemo(() => combine(endDate, endTime), [endDate, endTime]);
  const errors = validate(title, startAt, endAt, !startEdited);
  const hasErrors = Object.keys(errors).length > 0;

  /** A start time meaningfully ahead of now — as opposed to "now" itself,
   *  including the ordinary few seconds of clock skew between opening this
   *  popup (which defaults Start Time to the current moment) and clicking
   *  submit. This alone decides Start Now vs Schedule, both for the button's
   *  own label (STEP 6) and for what gets sent to the server. */
  const isFuture = startEdited && !!startAt && startAt.getTime() - Date.now() > GRACE_MS;

  const create = useMutation({
    mutationFn: (vars: { startAt: Date; endAt: Date; isFuture: boolean }) =>
      api.scheduleMeeting({
        title: title.trim(),
        media: "video",
        scheduledAt: vars.isFuture ? vars.startAt.toISOString() : undefined,
        // Only meaningful for a real future schedule — "start now" has no
        // fixed end the server needs to know about up front, same as
        // ScheduleCallDialog's own "no start time at all -> omit
        // durationMinutes too" reasoning.
        durationMinutes: vars.isFuture
          ? Math.round((vars.endAt.getTime() - vars.startAt.getTime()) / 60_000)
          : undefined,
      }),
    onSuccess: (call, vars) => {
      void qc.invalidateQueries({ queryKey: qk.calls });
      onClose();
      if (!vars.isFuture) onStarted?.(call);
    },
    onError: () => toast.error("Couldn't schedule that meeting"),
  });

  const submit = () => {
    if (hasErrors || !startAt || !endAt) {
      setAttempted(true);
      return;
    }
    create.mutate({ startAt, endAt, isFuture });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="New Meeting"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-y-auto rounded-2xl border border-gray-200 bg-white p-6 shadow-lg"
      >
        <div className="mb-5 flex shrink-0 items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">New Meeting</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="-mr-1 -mt-1 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-gray-700">Meeting Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter meeting title"
              maxLength={200}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-accent focus:ring-1 focus:ring-accent"
            />
            {attempted && errors.title && (
              <span className="text-xs text-danger">{errors.title}</span>
            )}
          </label>

          <DateTimeFields
            label="Start Time"
            date={startDate}
            time={startTime}
            onDateChange={(v) => {
              setStartEdited(true);
              setStartDate(v);
            }}
            onTimeChange={(v) => {
              setStartEdited(true);
              setStartTime(v);
            }}
            error={attempted ? errors.start : undefined}
          />

          <DateTimeFields
            label="End Time"
            date={endDate}
            time={endTime}
            onDateChange={setEndDate}
            onTimeChange={setEndTime}
            error={attempted ? errors.end : undefined}
          />
        </div>

        <div className="mt-6 flex shrink-0 items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={create.isPending}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition hover:brightness-105 disabled:opacity-60"
          >
            <Video size={15} />
            {create.isPending ? "Starting…" : isFuture ? "Schedule" : "Start Now"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DateTimeFields({
  label,
  date,
  time,
  onDateChange,
  onTimeChange,
  error,
}: {
  label: string;
  date: string;
  time: string;
  onDateChange: (v: string) => void;
  onTimeChange: (v: string) => void;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <div className="grid grid-cols-2 gap-2">
        <div className="relative">
          <Calendar
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-accent"
          />
          <input
            type="date"
            aria-label={`${label} date`}
            value={date}
            onChange={(e) => onDateChange(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-2 text-sm text-gray-900 outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>
        <div className="relative">
          <Clock
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-accent"
          />
          <input
            type="time"
            aria-label={`${label} time`}
            value={time}
            onChange={(e) => onTimeChange(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-7 text-sm text-gray-900 outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
          <ChevronDown
            size={14}
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400"
          />
        </div>
      </div>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
