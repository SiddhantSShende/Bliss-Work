import { Outlet, useLocation, Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { isMeetingDetailPath } from "../lib/meetingView";

/**
 * The Meetings section's frame.
 *
 * Everything under /app/meetings renders through here: the calendar at the
 * index, one meeting in full at /app/meetings/:callId. They take turns in the
 * same full-width pane rather than sitting side by side — the section used to
 * be three columns (buckets, list, reading pane) squeezed into the shell's main
 * area, and a calendar cannot be a calendar in a third of the width. The
 * bucket column's job is now the tab strip under the calendar, so the section
 * no longer asks the shell for a list pane at all (see lib/section).
 *
 * The way back out carries the WHOLE search string rather than rebuilding it.
 * Which week, which scale and which tab the user was looking at all ride in the
 * URL (see lib/meetingCalendar and lib/meetingView), and preserving the string
 * verbatim is what makes "back" return to exactly that view instead of to a
 * default one — including any parameter added here later.
 */
export function MeetingsLayout() {
  const loc = useLocation();
  const detailOpen = isMeetingDetailPath(loc.pathname);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {detailOpen && (
        <Link
          to={{ pathname: "/app/meetings/all", search: loc.search }}
          className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-2 text-xs font-medium text-muted transition-colors hover:text-fg"
        >
          <ChevronLeft size={15} /> Back to calendar
        </Link>
      )}
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
