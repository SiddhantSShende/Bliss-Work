import { Outlet, useLocation, useSearchParams, Link } from "react-router-dom";
import { CalendarDays, ChevronLeft } from "lucide-react";
import { EmptyState } from "@taskboard/ui";
import { MeetingList } from "./MeetingList";
import { bucketOf, isMeetingDetailPath, meetingSearch } from "../lib/meetingView";

/**
 * Meetings' second and third containers, side by side: the meeting list, and
 * the pane a meeting opens in.
 *
 * The same shape as MailLayout, and for the same reasons — everything under
 * /app/meetings renders through here, the list is this component's own child
 * (opening a meeting must not throw away the list it was picked out of), and
 * the pane beside it is the <Outlet/>. The first container — the buckets — is
 * a level above, in the app shell.
 *
 * ── Which pane a window shows ────────────────────────────────────────────────
 * Below xl there is only room for one of them, so the list gives way to the
 * open meeting and a back control brings it back. From xl up both are on screen
 * at once and the detail pane holds an empty state until something is selected.
 */
export function MeetingsLayout() {
  const [params] = useSearchParams();
  const detailOpen = isMeetingDetailPath(useLocation().pathname);
  // The way back out returns to the bucket the meeting was opened from, not to
  // a default list — the same reason mailView keeps the folder in the URL.
  const backToList = {
    pathname: "/app/meetings/all",
    search: meetingSearch(bucketOf(params)),
  };

  return (
    <div className="flex h-full min-w-0 gap-2">
      <div
        className={
          detailOpen
            ? "glass hidden min-w-0 flex-col overflow-hidden rounded-2xl xl:flex xl:w-[21rem] xl:shrink-0 2xl:w-[24rem]"
            : "glass flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl xl:w-[21rem] xl:flex-none 2xl:w-[24rem]"
        }
      >
        <MeetingList />
      </div>

      <section
        className={`glass min-w-0 flex-col overflow-hidden rounded-2xl ${
          detailOpen ? "flex flex-1" : "hidden flex-1 xl:flex"
        }`}
      >
        {detailOpen && (
          // Narrow windows put the detail pane OVER the list, so it needs its
          // own way back. Hidden from xl up, where the list never left.
          <Link
            to={backToList}
            className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-2 text-xs font-medium text-muted transition-colors hover:text-fg xl:hidden"
          >
            <ChevronLeft size={15} /> Back to meetings
          </Link>
        )}
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </section>
    </div>
  );
}

/** The detail pane before anything is opened. Only ever visible from xl up,
 *  where the list sits beside it rather than in its place. */
export function MeetingsWelcome() {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={<CalendarDays size={26} />}
        title="Nothing open"
        hint="Pick a meeting from the list to see who was there, what was said, and what was written down."
      />
    </div>
  );
}
