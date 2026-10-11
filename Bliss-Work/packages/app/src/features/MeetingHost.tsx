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
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Video, X } from "lucide-react";
import { Button } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { onMeetingJoinRequest, useMeetingSession, useResumableMeeting } from "../lib/MeetingSession";
import { closeMeetingTab } from "../lib/callWindow";
import { isCallOver } from "../lib/meetingView";
import { useSession } from "../store/session";
import { CallRoom } from "./CallRoomLazy";
import { IncomingMeetingNotice } from "./IncomingMeetingNotice";
import { ScheduledMeetingNotice } from "./ScheduledMeetingNotice";

export function MeetingHost() {
  const { t } = useTranslation("meetings");
  const { call, enter, exit, autoJoinMedia } = useMeetingSession();
  const { api } = useRuntime();

  useEffect(() => {
    let requestNumber = 0;
    return onMeetingJoinRequest((callId, media) => {
      const request = ++requestNumber;
      void api
        .call(callId)
        .then((next) => {
          // A newer request superseded this one — say nothing, the newer
          // one's own outcome (success or its own toast) is what matters now.
          if (request !== requestNumber) return;
          if (!isCallOver(next)) {
            enter(next, undefined, media);
          }
        })
        .catch((e: unknown) => {
          // Was silently swallowed entirely — clicking "Join"/"Open" on a
          // call-started/call-waiting/ring toast did nothing at all on any
          // failure (a network blip, a 403, a malformed response), with no
          // error and no room. Surfacing it is not optional here: this is
          // the ONLY feedback the person clicking that toast action gets.
          if (request !== requestNumber) return;
          toast.error(e instanceof Error ? e.message : t("host.openFailed"));
        });
    });
  }, [api, enter, t]);

  return (
    <>
      {call && <CallRoom call={call} onClose={exit} autoJoin={autoJoinMedia ?? undefined} />}
      {!call && <RejoinPrompt />}
      {/* Before IncomingMeetingNotice: same z-index, so on the rare overlap the
          meeting that is starting NOW paints over the one merely scheduled. */}
      <ScheduledMeetingNotice />
      <IncomingMeetingNotice />
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
  const { t } = useTranslation("meetings");
  const callId = useResumableMeeting();
  const { api } = useRuntime();
  const { enter } = useMeetingSession();
  const [dismissed, setDismissed] = useState(false);
  // MeetingHost sits outside SessionBootstrap (see App.tsx) so an active call
  // survives the periodic background token refresh — but that means this runs
  // before the FIRST bootstrap has restored a token too. On a reload of a tab
  // that was already in a meeting, resumable-meeting state is in sessionStorage
  // before the session is, and firing this against messaging-svc with no token
  // yet is a guaranteed 401, not a rare race — so wait for a real session.
  const sessionStatus = useSession((s) => s.status);

  const { data: call } = useQuery({
    queryKey: qk.call(callId ?? ""),
    queryFn: () => api.call(callId!),
    enabled: !!callId && !dismissed && sessionStatus === "authed",
    // One attempt: an offer that retries in the background is an offer that
    // appears a minute after the user stopped wondering about it.
    retry: false,
    staleTime: 0,
  });

  // A call that has since ended is not something to offer a way back into.
  if (!callId || dismissed || !call || isCallOver(call)) {
    return null;
  }

  return (
    <div
      role="alertdialog"
      aria-label={t("host.rejoin.ariaLabel")}
      className="fixed bottom-4 left-1/2 z-[150] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl bg-surface p-4 shadow-widget ring-1 ring-border"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Video size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-fg">
            {call.title || t("host.rejoin.untitled")}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {t("host.rejoin.description")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          title={t("host.rejoin.notNow")}
          aria-label={t("host.rejoin.notNow")}
          className="shrink-0 rounded-lg p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <X size={15} />
        </button>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
          {t("host.rejoin.notNow")}
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
          {t("host.rejoin.rejoinButton")}
        </Button>
      </div>
    </div>
  );
}
