import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, Video, Phone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@taskboard/ui";
import type { CallDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

/** Where the dialog is being opened from, which decides what it can offer.
 *
 *  A channel call gets no invite-link control at all — not disabled, ABSENT.
 *  The channel is the guest list, so a link would be a second, competing answer
 *  to "who may be here", and the server rejects minting one anyway. The same is
 *  true of a one-to-one `direct` call: the roster is the two of you.
 *
 *  `direct` also differs in one way the other two do not: it always needs a
 *  time. Ringing a chat right now is the call button in the header, so the only
 *  thing left for this dialog to arrange there is a later one. */
type Scope =
  | { kind: "channel"; channelId: string }
  | { kind: "meeting" }
  | { kind: "direct"; peerId: string; peerName: string };

/** How long the call is expected to run.
 *
 *  The server ENDS the call when this elapses, which is the point: a meeting
 *  whose organiser closed their laptop rather than pressing End used to stay
 *  live indefinitely, and everyone still on its roster went on being shown to
 *  their colleagues as "Busy". The organiser picks the length here rather than
 *  the product guessing one.
 *
 *  "No end time" is offered deliberately for the rare call that genuinely runs
 *  until people leave — an all-day room. Those still close when the last
 *  participant disconnects; they simply have no clock on them. */
const DURATIONS: { label: string; minutes: number }[] = [
  { label: "15m", minutes: 15 },
  { label: "30m", minutes: 30 },
  { label: "1h", minutes: 60 },
  { label: "2h", minutes: 120 },
  { label: "No end time", minutes: 0 },
];

/** Matches the server's own default (defaultCallMinutes in calls.go), so the
 *  form shows what would happen if it sent nothing. */
const DEFAULT_MINUTES = 60;

/** Turns a datetime-local value into the RFC3339 the API wants, or undefined
 *  for "start now". datetime-local has no zone, so it is interpreted in the
 *  viewer's timezone — which is what someone picking a time means. */
function toRFC3339(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Mirrors the server's own scheduleGraceWindow (calls.go): ordinary clock
 *  skew and the gap between picking a time and submitting, not a real past
 *  date. Kept in step so the client never rejects a value the server would
 *  have accepted, or the reverse. */
const SCHEDULE_GRACE_MS = 60_000;

interface MeetingFormErrors {
  title?: string;
  when?: string;
  endWhen?: string;
}

/**
 * Client-side mirror of the "New meeting" popup's own rules (see the task
 * this shipped with): title required; start time optional but, once given,
 * not in the past; end time required only once a start time is set, and only
 * ever later than it. Pure so it can run on every render — cheap, and it
 * means the Cancel/Submit row never has to guess whether it is stale.
 */
function meetingValidation(title: string, when: string, endWhen: string): MeetingFormErrors {
  const errors: MeetingFormErrors = {};
  if (!title.trim()) errors.title = "Meeting title is required.";

  let start: Date | null = null;
  if (when) {
    start = new Date(when);
    if (Number.isNaN(start.getTime())) {
      errors.when = "Enter a valid start time.";
    } else if (start.getTime() < Date.now() - SCHEDULE_GRACE_MS) {
      errors.when = "Start time can't be in the past.";
    }
  }

  if (when) {
    if (!endWhen) {
      errors.endWhen = "End time is required once you set a start time.";
    } else {
      const end = new Date(endWhen);
      if (Number.isNaN(end.getTime())) {
        errors.endWhen = "Enter a valid end time.";
      } else if (start && !Number.isNaN(start.getTime()) && end.getTime() <= start.getTime()) {
        errors.endWhen = "End time must be later than the start time.";
      }
    }
  }

  return errors;
}

/** Whole minutes between two datetime-local values, for the API's
 *  `durationMinutes` — the only knob it accepts for how long a call runs
 *  (see calls.go's scheduleCallReq). Rounded rather than truncated: the two
 *  values come from the same minute-granularity picker, so any fractional
 *  difference is floating-point noise in the Date round-trip, not a real
 *  sub-minute duration. */
function minutesBetween(fromLocal: string, toLocal: string): number {
  return Math.round((new Date(toLocal).getTime() - new Date(fromLocal).getTime()) / 60_000);
}

export function ScheduleCallDialog({
  scope,
  onClose,
  onStarted,
}: {
  scope: Scope;
  onClose: () => void;
  /** Fired when the call exists and should be opened immediately. */
  onStarted?: (call: CallDTO) => void;
}) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [media, setMedia] = useState<"audio" | "video">("video");
  const [when, setWhen] = useState("");
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES);
  /** Meeting scope only — the popup's "End Time" field. A literal end time
   *  rather than the duration presets the other two scopes use (see the New
   *  Meeting popup's own spec: title, start time, end time, nothing else). */
  const [endWhen, setEndWhen] = useState("");
  /** Meeting scope only — set on the first submit attempt, so validation
   *  messages appear once the user has tried to go rather than nagging them
   *  before they have typed anything. */
  const [attempted, setAttempted] = useState(false);
  const [created, setCreated] = useState<CallDTO | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const meetingErrors = scope.kind === "meeting" ? meetingValidation(title, when, endWhen) : {};
  const hasMeetingErrors = Object.keys(meetingErrors).length > 0;

  const create = useMutation({
    mutationFn: async () => {
      const at = toRFC3339(when);
      if (scope.kind === "meeting") {
        return api.scheduleMeeting({
          title: title.trim(),
          media: "video",
          scheduledAt: at,
          // No start time at all -> omit durationMinutes too, so the server's
          // own default applies: no scheduled end for "start now" (see
          // parseSchedule in calls.go). A start time always carries an end
          // time here (the popup requires one), so its exact length is what
          // gets sent rather than a preset.
          durationMinutes: at && endWhen ? minutesBetween(when, endWhen) : undefined,
        });
      }
      const body = { title: title.trim(), media, scheduledAt: at, durationMinutes: minutes };
      if (scope.kind === "channel") return api.scheduleChannelCall(scope.channelId, body);
      // The submit control is disabled without a time in this scope, so `at`
      // is present by the time this runs.
      return api.scheduleDirectCall(scope.peerId, { ...body, scheduledAt: at! });
    },
    onSuccess: (call) => {
      void qc.invalidateQueries({ queryKey: qk.calls });
      if (scope.kind === "channel") {
        void qc.invalidateQueries({ queryKey: qk.channelCalls(scope.channelId) });
      }
      setCreated(call);
      // "Meet now" should not make you click twice.
      if (!when && onStarted) onStarted(call);
    },
    onError: () => toast.error("Couldn't schedule that call"),
  });

  const submit = () => {
    if (scope.kind === "meeting" && hasMeetingErrors) {
      setAttempted(true);
      return;
    }
    create.mutate();
  };

  const mintLink = useMutation({
    mutationFn: async () => {
      if (!created) throw new Error("no call");
      const inv = await api.createCallInvite(created.id);
      // The join route reads ?t=. The token is returned exactly once, so this
      // is the only moment it can be turned into a URL.
      return `${window.location.origin}/join?t=${encodeURIComponent(inv.token)}`;
    },
    onSuccess: setLink,
    onError: () => toast.error("Couldn't create an invite link"),
  });

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold text-fg">
          {scope.kind === "channel"
            ? "Start a channel call"
            : scope.kind === "direct"
              ? "Schedule a call"
              : "New meeting"}
        </h2>
        <p className="mb-4 text-xs text-muted">
          {scope.kind === "channel"
            ? "Everyone in this channel can join. There is no invite link — channel membership is the invitation."
            : scope.kind === "direct"
              ? `${scope.peerName} will be able to join at the time you pick. Whoever schedules it opens it.`
              : "Invite anyone with a BlissWork account by link, including people outside your organisation."}
        </p>

        {!created ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">
                Title{" "}
                {scope.kind === "meeting" && <span className="font-normal">— required</span>}
              </span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder={scope.kind === "channel" ? "Design sync" : "Weekly review"}
                className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
              />
              {scope.kind === "meeting" && attempted && meetingErrors.title && (
                <span className="text-xs text-danger">{meetingErrors.title}</span>
              )}
            </label>

            {/* Not part of the New Meeting popup's own spec (title, start,
                end, Cancel, Start Now/Schedule — nothing else) — channel and
                direct calls keep choosing audio vs video here. */}
            {scope.kind !== "meeting" && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">Type</span>
                <div className="flex gap-2">
                  <Button
                    variant={media === "video" ? "primary" : "ghost"}
                    size="sm"
                    onClick={() => setMedia("video")}
                  >
                    <Video size={14} /> Video
                  </Button>
                  <Button
                    variant={media === "audio" ? "primary" : "ghost"}
                    size="sm"
                    onClick={() => setMedia("audio")}
                  >
                    <Phone size={14} /> Audio
                  </Button>
                </div>
              </div>
            )}

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">
                {scope.kind === "meeting" ? "Start time" : "When"}{" "}
                <span className="font-normal">
                  {scope.kind === "direct" ? "— required" : "— leave empty to start now"}
                </span>
              </span>
              <input
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
              />
              {scope.kind === "meeting" && attempted && meetingErrors.when && (
                <span className="text-xs text-danger">{meetingErrors.when}</span>
              )}
            </label>

            {scope.kind === "meeting" ? (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">
                  End time{" "}
                  <span className="font-normal">
                    {when ? "— required" : "— set a start time first"}
                  </span>
                </span>
                <input
                  type="datetime-local"
                  value={endWhen}
                  onChange={(e) => setEndWhen(e.target.value)}
                  disabled={!when}
                  className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent disabled:cursor-not-allowed"
                />
                {attempted && meetingErrors.endWhen && (
                  <span className="text-xs text-danger">{meetingErrors.endWhen}</span>
                )}
              </label>
            ) : (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">
                  Length{" "}
                  <span className="font-normal">— the call ends automatically when it runs out</span>
                </span>
                <div className="flex flex-wrap gap-2">
                  {DURATIONS.map((d) => (
                    <Button
                      key={d.minutes}
                      variant={minutes === d.minutes ? "primary" : "ghost"}
                      size="sm"
                      onClick={() => setMinutes(d.minutes)}
                    >
                      {d.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={submit}
                disabled={create.isPending || (scope.kind === "direct" && !when)}
              >
                {scope.kind === "meeting"
                  ? when
                    ? "Schedule"
                    : "Start Now"
                  : when || scope.kind === "direct"
                    ? "Schedule"
                    : "Start now"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-fg">
              {created.title || "Untitled"}
              <div className="text-xs text-muted">
                {created.scheduledAt
                  ? new Date(created.scheduledAt).toLocaleString()
                  : "Started now"}
                {created.endsAt && ` — ends ${new Date(created.endsAt).toLocaleTimeString()}`}
              </div>
            </div>

            {/* Meetings only. See the Scope docstring — this control does not
                exist for a channel call rather than being disabled. */}
            {scope.kind === "meeting" && (
              <div className="flex flex-col gap-2">
                {!link ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => mintLink.mutate()}
                    disabled={mintLink.isPending}
                  >
                    Create invite link
                  </Button>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <input
                        readOnly
                        value={link}
                        onFocus={(e) => e.currentTarget.select()}
                        className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-fg"
                      />
                      <Button variant="ghost" size="sm" onClick={() => void copy()}>
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted">
                      Anyone signed in to BlissWork can use this to join, including people in
                      other organisations. It expires in 24 hours, and ending the call revokes
                      it. Copy it now — it cannot be shown again.
                    </p>
                  </>
                )}
              </div>
            )}

            <div className="mt-1 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Done
              </Button>
              {onStarted && (
                <Button size="sm" onClick={() => onStarted(created)}>
                  Join now
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
