import { useMemo } from "react";
import { NavLink, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AlertCircle, Calendar, Clock, Users } from "lucide-react";
import { Badge, Button, EmptyState, Spinner } from "@taskboard/ui";
import type { CallDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { useUserLabels } from "../lib/userLabel";
import { groupByDay, timeLabel, whenOf } from "../lib/meetingTime";
import {
  bucketFor,
  bucketOf,
  durationLabel,
  durationMsOf,
  meetingDisplayName,
  meetingSearch,
  statusLabel,
} from "../lib/meetingView";

/**
 * Meetings' second container: the meetings in the selected bucket, grouped by
 * day, each row opening into the pane beside it.
 *
 * ── Two sources, deliberately ────────────────────────────────────────────────
 * Upcoming and Live come from `myCalls()` — the same single bounded request the
 * section has always used, untouched, and the one the call notifications and
 * the rest of the app already keep warm. Both buckets are bounded by what is
 * actually on a calendar, so there is nothing to page.
 *
 * PAST is different in kind. It has no end, and `myCalls()` deliberately caps
 * its history at a month — which used to make "Past" quietly stop a month back
 * with nothing saying so. It therefore reads `myCallHistory()`, a keyset cursor
 * with no day cap, five at a time behind an explicit "Load more" — a click, not
 * a scroll trigger, so a long history never fetches more than the user asked
 * to see. That is the whole of "Past must handle a large number of meetings":
 * the client holds exactly one page, and the server never sorts more than one.
 */
const PAST_PAGE_SIZE = 5;

export function MeetingList() {
  const [params] = useSearchParams();
  const bucket = bucketOf(params);
  const { callId } = useParams();
  const { api } = useRuntime();
  const viewerId = useSession((s) => s.user?.id ?? null);

  // Upcoming + Live. One request for the section, shared with the folder column.
  const live = useQuery({ queryKey: qk.calls, queryFn: () => api.myCalls() });

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
    if (bucket === "past") {
      return (history.data?.pages ?? []).flatMap((p) => p.items);
    }
    return (live.data ?? [])
      .filter((c) => bucketFor(c) === bucket)
      // Upcoming reads soonest-first — it is a plan. Live reads newest-first.
      .sort((a, b) => (bucket === "upcoming" ? whenOf(a) - whenOf(b) : whenOf(b) - whenOf(a)));
  }, [bucket, live.data, history.data]);

  // ONE id set for the whole column, not one per row: the name lookup is cached
  // by the set it was asked for, so a row computing its own would get its own
  // cache entry and its own request.
  const labelIds = useMemo(
    () => rows.flatMap((c) => [...c.participants.map((p) => p.userId), c.createdBy]),
    [rows],
  );
  const { nameOf } = useUserLabels(labelIds);

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = history;

  const q = bucket === "past" ? history : live;
  const groups = groupByDay(rows);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-fg">
          {bucket === "upcoming" ? "Upcoming" : bucket === "live" ? "Live now" : "Past meetings"}
        </h3>
        {rows.length > 0 && (
          <span className="text-xs text-muted">
            {rows.length}
            {bucket === "past" && hasNextPage ? "+" : ""}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {q.isLoading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted">
            <Spinner /> Loading…
          </div>
        ) : q.isError ? (
          // z.array(CallDTO) fails its ENTIRE parse if even one row is
          // malformed, which would empty the list with no indication anything
          // went wrong — "No past meetings" reads as a true fact about your
          // calendar, not as a failed request. This is the ONE case that must
          // never render as the empty state.
          <div className="m-2 flex flex-col items-center gap-3 rounded-xl border border-border/60 p-6 text-center">
            <AlertCircle size={22} className="text-muted" />
            <div className="text-sm font-medium text-fg">Couldn't load your meetings.</div>
            <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
              Retry
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Calendar size={24} />}
            title={
              bucket === "upcoming"
                ? "Nothing scheduled"
                : bucket === "live"
                  ? "Nothing live right now"
                  : "No past meetings"
            }
            hint={
              bucket === "past"
                ? "Meetings you've been part of will be listed here once they end."
                : "Start a meeting now, or put one in the calendar."
            }
          />
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <section key={g.label}>
                <h4 className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {g.label}
                </h4>
                <div className="space-y-1">
                  {g.items.map((c) => (
                    <MeetingListRow
                      key={c.id}
                      call={c}
                      selected={c.id === callId}
                      search={meetingSearch(bucket)}
                      name={meetingDisplayName(c, nameOf, viewerId)}
                    />
                  ))}
                </div>
              </section>
            ))}
            {bucket === "past" &&
              (hasNextPage ? (
                <div className="py-3 text-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={isFetchingNextPage}
                    onClick={() => void fetchNextPage()}
                  >
                    Load more
                  </Button>
                </div>
              ) : (
                <div className="py-3 text-center text-xs text-muted">That's everything.</div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One meeting, said in the space a list row has.
 *
 * Everything the brief asks a row to carry: what it is called (its title, or
 * the people who were in it), the day, the start and end times, how long it
 * ran, and which bucket it is in. The full record is one click away in the pane
 * beside it, so nothing here has to be the last word.
 */
function MeetingListRow({
  call,
  selected,
  search,
  name,
}: {
  call: CallDTO;
  selected: boolean;
  search: string;
  name: string;
}) {
  const start = whenOf(call);
  const end = call.endedAt ? new Date(call.endedAt).getTime() : null;
  const joined = call.participants.filter((p) => p.joinedAt).length;
  const bucket = bucketFor(call);

  return (
    <NavLink
      to={{ pathname: `/app/meetings/${call.id}`, search }}
      aria-current={selected ? "page" : undefined}
      className={`block rounded-xl p-2.5 transition-colors ${
        selected
          ? "bg-gradient-to-r from-accent/20 to-accent/5 ring-1 ring-accent/15"
          : "hover:bg-surface-2"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{name}</span>
        {bucket === "live" ? (
          <Badge tone="success" className="shrink-0">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> Live
          </Badge>
        ) : (
          <Badge tone={bucket === "upcoming" ? "accent" : "neutral"} className="shrink-0">
            {statusLabel(call)}
          </Badge>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
        <span className="inline-flex items-center gap-1">
          <Clock size={12} className="shrink-0" />
          {/* The day is already the group heading above; the row says the clock
              times, and the end only once there IS one — a live meeting has no
              end yet, and printing a scheduled one as though it happened would
              be inventing history. */}
          {timeLabel(start)}
          {end ? ` – ${timeLabel(end)}` : ""}
        </span>
        <span>{durationLabel(durationMsOf(call))}</span>
        {joined > 0 && (
          <span className="inline-flex items-center gap-1">
            <Users size={12} className="shrink-0" />
            {joined}
          </span>
        )}
      </div>
    </NavLink>
  );
}
