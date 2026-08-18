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
  const [created, setCreated] = useState<CallDTO | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: async () => {
      const at = toRFC3339(when);
      const body = { title: title.trim(), media, scheduledAt: at };
      if (scope.kind === "channel") return api.scheduleChannelCall(scope.channelId, body);
      // The submit control is disabled without a time in this scope, so `at`
      // is present by the time this runs.
      if (scope.kind === "direct")
        return api.scheduleDirectCall(scope.peerId, { ...body, scheduledAt: at! });
      return api.scheduleMeeting(body);
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
              <input
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
              />
              
            </label>

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
