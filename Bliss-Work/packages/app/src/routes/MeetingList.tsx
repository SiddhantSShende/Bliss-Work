import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AlertCircle, Calendar } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, EmptyState, Spinner } from "@taskboard/ui";
import type { CallDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { useUserLabels } from "../lib/userLabel";
import { whenOf } from "../lib/meetingTime";
import {
  MEETING_BUCKETS,
  NO_MEETING_FILTER,
  bucketFor,
  bucketLabel,
  bucketOf,
  matchesFilter,
  meetingDisplayName,
  meetingSearch,
  type MeetingBucket,
  type MeetingFilter,
} from "../lib/meetingView";
import { useLapseRevalidation } from "../lib/useLapseRevalidation";
import { MeetingRow } from "../features/MeetingRow";
import { MeetingFilterMenu } from "../features/MeetingFilterMenu";

/**
 * The meeting list under the calendar: Upcoming, Live and Past, each row saying
 * what the meeting is, when it is, who called it, how many people are on it,
 * and what can be done about it.
 *
 * ── Two sources, deliberately ────────────────────────────────────────────────
 * Unchanged from the column this replaced. Upcoming and Live come from
 * `myCalls()` — the same single bounded request the section has always used,
 * and the one the call notifications and the rest of the app already keep warm.
 * Both are bounded by what is actually on a calendar, so there is nothing to
 * page.
 *
 * PAST is different in kind. It has no end, and `myCalls()` deliberately caps
 * its history at a month — which used to make "Past" quietly stop a month back
 * with nothing saying so. It therefore reads `myCallHistory()`, a keyset cursor
 * with no day cap, five at a time behind an explicit "Load more" — a click, not
 * a scroll trigger, so a long history never fetches more than the user asked to
 * see.
 *
 * Deliberately NOT the calendar's own windowed read: these three answer "what
 * am I expected at", which is a different question from "what is in this week"
 * and must not empty out when somebody pages the calendar to March.
 *
 * The bucket lives in the URL (`?view=`), same as before and for the same
 * reason — opening a meeting and coming back has to return to the tab it was
 * picked out of, and the detail is a different route.
 */
const PAST_PAGE_SIZE = 5;

export function MeetingList({
  filter = NO_MEETING_FILTER,
  onFilterChange,
  selectedMeetingId,
  onOpenRoom,
}: {
  /** The calendar's filter, applied here too so the page narrows as one thing
   *  rather than as two halves that disagree. */
  filter?: MeetingFilter;
  onFilterChange?: (filter: MeetingFilter) => void;
  selectedMeetingId?: string | null;
  /** Join/Open — the caller owns it because entering a room is a session-level
   *  act (a tab, or the in-app overlay), not something a list row can decide. */
  onOpenRoom?: (call: CallDTO) => void;
}) {
  const { t } = useTranslation("meetings");
  const [params, setParams] = useSearchParams();
  const bucket = bucketOf(params);
  const { api } = useRuntime();
  const viewerId = useSession((s) => s.user?.id ?? null);
  const [filterOpen, setFilterOpen] = useState(false);

  // Upcoming + Live. One request for the section, shared with everything else
  // that reads qk.calls.
  const live = useQuery({ queryKey: qk.calls, queryFn: () => api.myCalls() });
  // The server decides what is live. A meeting that reaches its end while this
  // page is open is dropped by asking the server again when it is due, not by
  // this list second-guessing it from the local clock.
  const { refetch: refetchLive } = live;
  const revalidateLive = useCallback(() => void refetchLive(), [refetchLive]);
  useLapseRevalidation(live.data, revalidateLive);

  // Past, paged. Only fetched while Past is open — nobody's history should be
  // downloaded because they glanced at their calendar.
  const history = useInfiniteQuery({
    queryKey: qk.callHistory,
    queryFn: ({ pageParam }) => api.myCallHistory(pageParam as string | undefined, PAST_PAGE_SIZE),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: bucket === "past",
  });

  const rows = useMemo(() => {
    const source =
      bucket === "past"
        ? (history.data?.pages ?? []).flatMap((p) => p.items)
        : (live.data ?? [])
            .filter((c) => bucketFor(c) === bucket)
            // Upcoming reads soonest-first — it is a plan. Live reads newest-first.
            .sort((a, b) => (bucket === "upcoming" ? whenOf(a) - whenOf(b) : whenOf(b) - whenOf(a)));
    return source.filter((c) => matchesFilter(c, filter, viewerId));
  }, [bucket, live.data, history.data, filter, viewerId]);

  const counts = useMemo(() => {
    const of = (b: MeetingBucket) =>
      (live.data ?? []).filter((c) => bucketFor(c) === b && matchesFilter(c, filter, viewerId))
        .length;
    // Past is deliberately NOT counted: it is paged from a different endpoint
    // with no end, so any number here would be "the first page", which is worse
    // than no number.
    return { upcoming: of("upcoming"), live: of("live"), past: null } as Record<
      MeetingBucket,
      number | null
    >;
  }, [live.data, filter, viewerId]);

  // ONE id set for the whole list, not one per row: the name lookup is cached
  // by the set it was asked for, so a row computing its own would get its own
  // cache entry and its own request.
  const labelIds = useMemo(
    () => rows.flatMap((c) => [...c.participants.map((p) => p.userId), c.createdBy]),
    [rows],
  );
  const { nameOf, avatarUrlOf } = useUserLabels(labelIds);

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = history;
  const q = bucket === "past" ? history : live;

  /** Switch tab WITHOUT disturbing the calendar's own parameters — which week
   *  and which scale are on screen are not the list's business, and rebuilding
   *  the search string from scratch here would drop them. */
  const selectBucket = (next: MeetingBucket) => {
    const p = new URLSearchParams(params);
    p.delete("view");
    // Asked of meetingSearch rather than compared against a literal, so which
    // bucket is the default — and therefore needs no parameter at all — stays
    // its answer alone.
    const view = new URLSearchParams(meetingSearch(next).slice(1)).get("view");
    if (view) p.set("view", view);
    setParams(p, { replace: true });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-3 py-2">
        {MEETING_BUCKETS.map((b) => {
          const on = b.key === bucket;
          const count = counts[b.key];
          return (
            <button
              key={b.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => selectBucket(b.key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                on ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-fg"
              }`}
            >
              {bucketLabel(b.key)}
              {count !== null && count > 0 && (
                <span className="ml-1.5 text-xs opacity-70">{count}</span>
              )}
            </button>
          );
        })}
        {onFilterChange && (
          <div className="ml-auto">
            <MeetingFilterMenu value={filter} onChange={onFilterChange} open={filterOpen} onOpenChange={setFilterOpen} />
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {q.isLoading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted">
            <Spinner /> {t("list.loading")}
          </div>
        ) : q.isError ? (
          // z.array(CallDTO) fails its ENTIRE parse if even one row is
          // malformed, which would empty the list with no indication anything
          // went wrong — "No past meetings" reads as a true fact about your
          // calendar, not as a failed request. This is the ONE case that must
          // never render as the empty state.
          <div className="m-3 flex flex-col items-center gap-3 rounded-xl border border-border/60 p-6 text-center">
            <AlertCircle size={22} className="text-muted" />
            <div className="text-sm font-medium text-fg">{t("list.error.title")}</div>
            <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
              {t("list.error.retry")}
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="py-4">
            <EmptyState
              icon={<Calendar size={24} />}
              title={
                bucket === "upcoming"
                  ? t("list.empty.upcomingTitle")
                  : bucket === "live"
                    ? t("list.empty.liveTitle")
                    : t("list.empty.pastTitle")
              }
              hint={
                bucket === "past"
                  ? t("list.empty.pastHint")
                  : t("list.empty.startHint")
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-border/50">
            {rows.map((call) => (
              <MeetingRow
                key={call.id}
                call={call}
                compact
                selected={call.id === selectedMeetingId}
                search={params.toString()}
                name={meetingDisplayName(call, nameOf, viewerId)}
                organiser={nameOf(call.createdBy)}
                organiserAvatar={avatarUrlOf(call.createdBy)}
                onOpenRoom={onOpenRoom}
              />
            ))}
          </ul>
        )}

        {bucket === "past" &&
          !q.isLoading &&
          !q.isError &&
          rows.length > 0 &&
          (hasNextPage ? (
            <div className="py-3 text-center">
              <Button
                variant="ghost"
                size="sm"
                loading={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
              >
                {t("list.loadMore")}
              </Button>
            </div>
          ) : (
            <div className="py-3 text-center text-xs text-muted">{t("list.allLoaded")}</div>
          ))}
      </div>
    </div>
  );
}
