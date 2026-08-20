/**
 * The meeting room, as its own page.
 *
 * Reached at /call/:callId, normally in a tab of its own (lib/callWindow), so
 * the rest of BlissWork stays usable during a meeting. It sits OUTSIDE /app for
 * the same reason /join does: the room is the whole surface, and wrapping it in
 * the app shell would put a sidebar beside a video grid in a window that exists
 * to hold the video grid.
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
import { useCallback, useEffect } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { Button, EmptyState } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { OPENED_BY_APP_PARAM, closeMeetingTab, rememberMeetingTab } from "../lib/callWindow";
import { useMeetingSession } from "../lib/MeetingSession";

export function CallWindow() {
  const { callId = "" } = useParams();
  const [params] = useSearchParams();
  const { api } = useRuntime();
  const nav = useNavigate();
  const { enter, call: active } = useMeetingSession();

  const {
    data: call,
    isError,
    isLoading,
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

  /**
   * Hand the meeting to the session that lives above the router.
   *
   * This route does NOT render the room. A room mounted by a route dies the
   * moment the user goes anywhere — that unmount is what disconnects and posts
   * the leave — so the meeting is owned one level up and this page only asks
   * for it. What stays here is the tab's own business: its title, and what
   * closing it means.
   */
  useEffect(() => {
    if (!call || active?.id === call.id) return;
    enter(call, close);
  }, [call, active?.id, enter, close]);

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

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-sm text-muted">
        Opening the meeting…
      </div>
    );
  }

  if (isError || !call) {
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

  return (
    <div className="flex h-full items-center justify-center bg-surface text-sm text-muted">
      Joining the meeting…
    </div>
  );
}
