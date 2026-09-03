/**
 * The meeting room, as its own page.
 *
 * Reached at /call/:callId, normally in a tab of its own (lib/callWindow), so
 * the rest of BlissWork stays usable during a meeting. It sits OUTSIDE /app for
 * the same reason /join does: the room is the whole surface, and wrapping it in
 * the app shell would put a sidebar beside a video grid in a window that exists
 * to hold the video grid.
 *
 * ── Renders CallRoom directly ────────────────────────────────────────────────
 * This used to hand the call to `MeetingSession`/`MeetingHost` (`enter(call)`)
 * and show a static "Joining the meeting…" placeholder, trusting a component
 * mounted elsewhere in the tree to pick it up and render the room over it. That
 * placeholder had no connection to whether the hand-off actually worked — no
 * signal back if `MeetingHost` never rendered the room, if its lazy chunk
 * failed, or if the pre-join screen (the thing that actually requests the
 * meeting token — see CallRoom's `preJoin`) never appeared for the user to
 * click. Any hiccup there left the tab exactly on that placeholder forever,
 * with no token request ever made, and nothing on screen to say why.
 *
 * This route now owns the room directly: fetch the call, then render `CallRoom`
 * (still lazy — see features/CallRoomLazy) itself. `MeetingSession`/
 * `MeetingHost` remain exactly as they were for every OTHER way a meeting is
 * entered (Meetings, ChannelView, JoinCallView, the call-started toast) — this
 * tab's whole reason to exist is the meeting, so it does not need a piece of
 * state that lets a meeting survive navigating to some other page. It renders
 * inside `<MeetingSessionContext.Provider value={null}>` for the same reason:
 * CallRoom already has a "no session" mode (built for its own dev-preview
 * harness) that shows no Minimise control and no MiniMeeting bubble, which is
 * the right behaviour here — the app-wide session's `minimize()` would
 * navigate this very tab to /app/meetings, tearing down the room this route
 * itself is now responsible for keeping mounted.
 *
 * Closing behaves like whatever this tab is. One this app opened can close
 * itself; one someone bookmarked or reloaded into cannot — `window.close()` is
 * refused for a tab the script did not open — so that case goes back to
 * Meetings rather than leaving a dead page behind.
 *
 * Which of the two this is comes from the mark `openCallTab` puts on the URL,
 * NOT from `window.opener`: that link is deliberately severed on the way out
 * (see lib/callWindow), so reading it here was always false and every meeting
 * ended by navigating this tab into /app — a second copy of BlissWork left open
 * instead of the tab closing.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { Button, EmptyState } from "@taskboard/ui";
import { useConnectEventBridge, useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { OPENED_BY_APP_PARAM, closeMeetingTab, rememberMeetingTab } from "../lib/callWindow";
import { MeetingSessionContext } from "../lib/MeetingSession";
import { CallRoom } from "../features/CallRoomLazy";

export function CallWindow() {
  const { callId = "" } = useParams();
  const [params] = useSearchParams();
  const { api } = useRuntime();
  const nav = useNavigate();
  const [retrying, setRetrying] = useState(false);

  // This route sits outside /app, so WsEventBridge (mounted only in
  // AppShell) never runs here — without this, a meeting popped into its own
  // tab never hears CallStarted (the lobby's auto-join) or CallEnded (the
  // auto-close below) over a live socket, only ever the 30s lobby poll
  // fallback. Same fix JoinCallView needs, for the same reason.
  useConnectEventBridge();

  const {
    data: call,
    isError,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: qk.call(callId),
    queryFn: () => api.call(callId),
    enabled: !!callId,
    // The room joins from this row; a stale one would have it joining a call
    // that has since ended.
    staleTime: 0,
    retry: 1,
  });

  // Remember what this tab is for, before anything can navigate away from the
  // meeting route. Kept per-tab rather than in the URL alone so it survives the
  // user browsing the rest of BlissWork with the meeting still running.
  const openedByApp = params.get(OPENED_BY_APP_PARAM) === "1";
  useEffect(() => {
    if (openedByApp && callId) rememberMeetingTab(callId);
  }, [openedByApp, callId]);

  const close = useCallback(() => {
    closeMeetingTab(() => nav("/app/meetings", { replace: true }));
  }, [nav]);

  // By the time this route renders at all, RequireAuth + SessionBootstrap
  // (App.tsx) have already resolved a session — there is no unauthenticated
  // path into this component.
  useEffect(() => {
    console.debug("[CALL WINDOW] Session initialized");
  }, []);

  useEffect(() => {
    if (callId) console.debug("[CALL WINDOW] Loading call:", callId);
  }, [callId]);

  useEffect(() => {
    if (call) console.debug("[CALL WINDOW] Call loaded");
  }, [call]);

  // The tab's own title says which meeting, because a person in three of these
  // has three identical tabs otherwise.
  useEffect(() => {
    if (!call) return;
    const previous = document.title;
    document.title = `${call.title || "Meeting"} · BlissWork`;
    return () => {
      document.title = previous;
    };
  }, [call]);

  const retry = () => {
    setRetrying(true);
    void refetch().finally(() => setRetrying(false));
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-sm text-muted">
        Loading meeting…
      </div>
    );
  }

  // The call row itself could not be fetched at all — a network failure, or an
  // invalid/unknown call id. Distinct from "the meeting ended" below: this is
  // something a retry can plausibly fix, that one is not.
  if (isError || !call) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-surface p-6">
        <EmptyState
          icon={<AlertCircle size={24} />}
          title="Unable to load this meeting."
          hint="Check your connection and try again."
        />
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={close}>
            Return to Meetings
          </Button>
          <Button size="sm" onClick={retry} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        </div>
      </div>
    );
  }

  // A call already ENDED/CANCELLED is not something to connect into — same
  // exclusion RejoinPrompt (MeetingHost.tsx) applies to its own reload-recovery
  // path. Without this, a hard refresh landing here for a call that ended
  // while the tab was gone would hand it to the room, which only discovers the
  // problem later via LiveKit's own connect timeout — a needless "Connecting…"
  // instead of an immediate answer.
  if (call.status === "ENDED" || call.status === "CANCELLED") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-surface p-6">
        <EmptyState
          icon={<AlertCircle size={24} />}
          title="This meeting isn't available"
          hint="It may have ended, or you may no longer be on its roster."
        />
        <Button variant="ghost" size="sm" onClick={close}>
          Close
        </Button>
      </div>
    );
  }

  console.debug("[CALL WINDOW] Rendering CallRoom directly");
  return (
    <MeetingSessionContext.Provider value={null}>
      <CallRoom call={call} onClose={close} />
    </MeetingSessionContext.Provider>
  );
}
