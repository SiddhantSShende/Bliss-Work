import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarPlus, CalendarClock, History, Radio, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { ListHeader, rowClass } from "../features/ListPane";
import { NewMeetingDialog } from "../features/NewMeetingDialog";
import { openCallTab } from "../lib/callWindow";
import { useMeetingSession } from "../lib/MeetingSession";
import { MEETING_BUCKETS, bucketFor, bucketOf, meetingSearch, type MeetingBucket } from "../lib/meetingView";

/**
 * Meetings' first container: Upcoming, Live and Past — the same role Mail's
 * folder column plays, and deliberately the same shape.
 *
 * The section used to be a single full-width page with a tab strip, which made
 * a meeting something you looked at IN a list rather than something you opened.
 * Everything a finished meeting now holds — its roster, its chat, its notes,
 * its recording — needs a pane of its own, so the section grew the three-column
 * shape Mail already has and this is its left edge.
 *
 * The chosen bucket lives in the URL (?view=), not in state, for the reason
 * lib/mailView gives for the mailbox: opening a meeting and coming back has to
 * return to the list it was picked out of, and this column and the list are
 * rendered by different parts of the tree.
 *
 * New meeting lives HERE rather than in the list beside it, unlike Mail's New
 * Mail — scheduling is not an act on the bucket you happen to be looking at.
 */
const LIST_PATH = "/app/meetings/all";

const BUCKET_ICONS: Record<MeetingBucket, LucideIcon> = {
  upcoming: CalendarClock,
  live: Radio,
  past: History,
};

export function MeetingFolders() {
  const [params] = useSearchParams();
  const active = bucketOf(params);
  const { api, config } = useRuntime();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const { enter, restore, call: activeCall } = useMeetingSession();

  // The SAME query the list reads, so the counts and the rows can never
  // disagree — and one request, not two, because TanStack dedupes the key.
  // Past is deliberately NOT counted from here: it is paged from a different
  // endpoint with no end, so any number this column could print would be "the
  // first page", which is worse than no number.
  const { data: calls = [] } = useQuery({ queryKey: qk.calls, queryFn: () => api.myCalls() });
  const counts: Record<MeetingBucket, number | null> = {
    upcoming: calls.filter((c) => bucketFor(c) === "upcoming").length,
    live: calls.filter((c) => bucketFor(c) === "live").length,
    past: null,
  };

  return (
    <>
      <ListHeader
        title="Meetings"
        action={
          <Button size="sm" onClick={() => setScheduleOpen(true)}>
            <CalendarPlus size={15} />
            <span className="hidden sm:inline">New</span>
          </Button>
        }
      />

      <nav className="shrink-0 space-y-0.5 px-2 pb-2 pt-2">
        {MEETING_BUCKETS.map((bucket) => {
          const Icon = BUCKET_ICONS[bucket.key];
          const isActive = bucket.key === active;
          const count = counts[bucket.key];
          const showCount = count !== null && count > 0;
          return (
            <Link
              key={bucket.key}
              to={{ pathname: LIST_PATH, search: meetingSearch(bucket.key) }}
              aria-current={isActive ? "page" : undefined}
              // Without this the badge folds into the link's accessible name and
              // a screen reader announces "Live 2" — a bare number with nothing
              // saying what it counts.
              aria-label={showCount ? `${bucket.label}, ${count} meetings` : undefined}
              className={rowClass(isActive)}
            >
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-xl ${
                  // Live is the one state that is happening right now, and the
                  // one worth spotting from across the column.
                  bucket.key === "live" && showCount
                    ? "bg-success/12 text-success"
                    : "bg-accent-soft text-accent"
                }`}
              >
                <Icon size={15} />
              </div>
              <span
                className={`min-w-0 flex-1 truncate text-sm font-semibold ${
                  isActive ? "text-fg" : "text-fg/90"
                }`}
              >
                {bucket.label}
              </span>
              {showCount && (
                <span className="rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-accent-fg">
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {scheduleOpen && (
        <NewMeetingDialog
          onClose={() => setScheduleOpen(false)}
          onStarted={(call) => {
            setScheduleOpen(false);
            // "Meet now" is a join like any other, and lands in the same tab the
            // Join button would have opened — unchanged from the old page.
            if (activeCall?.id === call.id) {
              restore();
              return;
            }
            if (openCallTab(call.id, config)) return;
            enter(call);
          }}
        />
      )}
    </>
  );
}
