/**
 * Where the meeting is actually mounted.
 *
 * One line of rendering, and that is the point: this sits above `<Routes>` so
 * the room it renders is not owned by any route, and nothing a user clicks can
 * unmount it. Routes ask for a meeting with `enter(call)` (see
 * lib/MeetingSession) and never render one themselves.
 *
 * Also the home of the rejoin offer, because it is the same question — "should
 * there be a meeting on screen?" — asked about the tab's previous life.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Video, X } from "lucide-react";
import { Button } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useMeetingSession, useResumableMeeting } from "../lib/MeetingSession";
import { closeMeetingTab } from "../lib/callWindow";
import { CallRoom } from "./CallRoomLazy";

export function MeetingHost() {
  const { call, exit } = useMeetingSession();

  return (
    <>
      {call && <CallRoom call={call} onClose={exit} />}
      {!call && <RejoinPrompt />}
    </>
  );
}

/**
 * "You were in a meeting. Rejoin?"
 *
 * ── Why an offer and not an automatic rejoin ─────────────────────────────────
 * Refreshing is also how people escape a call that has gone wrong — a wedged
 * connection, a camera that will not release, a room that froze. Putting them
 * straight back in would make the one recovery gesture they have unusable.
 *
 * ── Why this is honest ───────────────────────────────────────────────────────
 * Rejoining is a REAL join: the call is still LIVE server-side and the token
 * endpoint re-authorises from the database, so a meeting that ended, or one the
 * user is no longer on the roster of, simply does not come back. Nothing here
 * fakes a connection that is not there — if the call row cannot be fetched, the
 * offer is not made.
 */
function RejoinPrompt() {
  const callId = useResumableMeeting();
  const { api } = useRuntime();
  const { enter } = useMeetingSession();
  const [dismissed, setDismissed] = useState(false);

  const { data: call } = useQuery({
    queryKey: qk.call(callId ?? ""),
    queryFn: () => api.call(callId!),
    enabled: !!callId && !dismissed,
    // One attempt: an offer that retries in the background is an offer that
    // appears a minute after the user stopped wondering about it.
    retry: false,
    staleTime: 0,
  });

  // A call that has since ended is not something to offer a way back into.
  if (!callId || dismissed || !call || call.status === "ENDED" || call.status === "CANCELLED") {
    return null;
  }

  return (
    <div
      role="alertdialog"
      aria-label="Rejoin the meeting you were in"
      className="fixed bottom-4 left-1/2 z-[150] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl bg-surface p-4 shadow-widget ring-1 ring-border"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Video size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-fg">
            {call.title || "Meeting"}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            You were in this meeting before the page reloaded.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          title="Not now"
          aria-label="Not now"
          className="shrink-0 rounded-lg p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <X size={15} />
        </button>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
          Not now
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setDismissed(true);
            // Leaving this one goes wherever the tab belongs: a meeting tab
            // closes, anything else falls back to the meetings list.
            enter(call, () => closeMeetingTab(() => undefined));
          }}
        >
          Rejoin
        </Button>
      </div>
    </div>
  );
}
