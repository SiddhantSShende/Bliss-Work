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
 */
import { useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { Button, EmptyState } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { CallRoom } from "../features/CallRoomLazy";

export function CallWindow() {
  const { callId = "" } = useParams();
  const { api } = useRuntime();
  const nav = useNavigate();

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

  const close = useCallback(() => {
    if (window.opener) {
      window.close();
      return;
    }
    nav("/app/meetings", { replace: true });
  }, [nav]);

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

  return <CallRoom call={call} onClose={close} />;
}
