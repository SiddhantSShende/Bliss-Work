import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Video, Phone, Calendar, Clock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@taskboard/ui";
import type { CallDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

/** Where the dialog is being opened from, which decides what it can offer.
 *
 *  A channel call gets no invite-link control at all — not disabled, ABSENT.
 *  The channel is the guest list, so a link would be a second, competing answer
 *  to "who may be here", and the server rejects minting one anyway.
 *
 *  `direct` always needs a time. Ringing a chat right now is the call button
 *  in the header, so the only thing left for this dialog to arrange there is
 *  a later one.
 *
 *  Meetings have their own dedicated popup now — see features/
 *  NewMeetingDialog.tsx and its own doc comment for why that shape (two
 *  independently-labeled date+time fields, a predominantly-white card
 *  matching the product's reference design) no longer fits as a third
 *  branch of this component.
 */
type Scope =
  | { kind: "channel"; channelId: string }
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
  const [created, setCreated] = useState<CallDTO | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const at = toRFC3339(when);
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold text-fg">
          {scope.kind === "channel" ? "Start a channel call" : "Schedule a call"}
        </h2>
        <p className="mb-4 text-xs text-muted">
          {scope.kind === "channel"
            ? "Everyone in this channel can join. There is no invite link — channel membership is the invitation."
            : `${scope.peerName} will be able to join at the time you pick. Whoever schedules it opens it.`}
        </p>

        {!created ? (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">Title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder={scope.kind === "channel" ? "Design sync" : "Weekly review"}
                className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
              />
            </label>

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

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">
                When{" "}
                <span className="font-normal">
                  {scope.kind === "direct" ? "— required" : "— leave empty to start now"}
                </span>
              </span>
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1 text-fg">
                  <Calendar size={14} />
                  <Clock size={14} />
                </span>
                <input
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface-2 py-2 pl-12 pr-3 text-sm text-fg outline-none focus:border-accent"
                />
              </div>
            </label>

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

            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => create.mutate()}
                disabled={create.isPending || (scope.kind === "direct" && !when)}
              >
                {when || scope.kind === "direct" ? "Schedule" : "Start now"}
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
