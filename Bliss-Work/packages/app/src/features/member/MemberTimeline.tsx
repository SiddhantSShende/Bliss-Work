import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Activity, ExternalLink, ShieldCheck } from "lucide-react";
import { Badge, Button, EmptyState, Spinner } from "@taskboard/ui";
import type { ActivitySessionEntryDTO, TimelineEntry } from "@taskboard/shared";
import { useRuntime } from "../../lib/runtime";
import { qk } from "../../lib/queryBridge";
import { Tabs, type TabSpec } from "../Tabs";
import {
  actionLabel,
  activityTitle,
  activityUrl,
  collapseSwitches,
  dayHeading,
  destinationOf,
  formatDuration,
  indexSessionEntries,
  sessionEntryFor,
  siteContext,
  sourceLabel,
  type SessionEntryIndex,
} from "./activityLabels";

type Filter = "all" | "auth" | "engagement" | "navigation" | "app" | "site" | "security";

const FILTERS: TabSpec<Filter>[] = [
  { key: "all", label: "Everything" },
  { key: "engagement", label: "Work" },
  { key: "navigation", label: "In-app" },
  { key: "auth", label: "Sign-ins" },
  { key: "app", label: "Apps" },
  { key: "site", label: "Sites" },
  // Client-enforced controls the person ran into — today, refused screen
  // captures. Self-reported by definition: a screenshot happens in the
  // operating system, so this is what the app SAW and refused, not proof that
  // nothing was captured.
  { key: "security", label: "Security" },
];

/**
 * One member's activity, newest first, grouped by day.
 *
 * `userId` may be the literal "me" — the server resolves the subject, so this
 * exact component renders both the admin's view of someone else and a member's
 * view of their own record. One component, one code path, no chance of the
 * self-view accidentally showing something the admin view does not.
 */
export function MemberTimeline({ userId }: { userId: string }) {
  const { api } = useRuntime();
  const [filter, setFilter] = useState<Filter>("all");

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: [...qk.activityTimeline(userId), filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.activityTimeline(userId, {
        cursor: pageParam,
        limit: 50,
        category: filter === "all" ? undefined : filter,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  // The CORRELATED desktop+browser records (activity_sessions) — an OVERLAY
  // on the timeline above, not a replacement feed: this endpoint only covers
  // app/site rows (see its own doc comment), so auth/navigation/engagement/
  // security rows keep coming from `activityTimeline` exactly as before. One
  // page, not paginated in step with the timeline above — enrichment for
  // whatever page of the timeline is currently showing, refetched on the same
  // cache lifetime as the rest of this screen. A row this has no match for
  // (an older row, or the sessionizer had nothing to correlate yet) falls
  // back to the timeline-only rendering unchanged — see `sessionEntryFor`.
  const { data: sessionData } = useQuery({
    queryKey: qk.activitySessionEntries(userId),
    queryFn: () => api.activitySessionEntries(userId, { limit: 200 }),
  });
  const sessionIndex: SessionEntryIndex = indexSessionEntries(sessionData?.sessions ?? []);

  // Collapsed, not filtered: three producers can see the same switch from
  // different distances, and this keeps the one that names where the person
  // actually went. See collapseSwitches.
  const entries = collapseSwitches(data?.pages.flatMap((p) => p.entries) ?? []);

  return (
    <div className="space-y-4">
      <Tabs tabs={FILTERS} active={filter} onChange={setFilter} />

      {isLoading ? (
        <div className="flex justify-center p-8"><Spinner /></div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<Activity size={22} />}
          title="No activity recorded yet"
          hint="Activity appears here as they use BlissWork."
        />
      ) : (
        <div className="space-y-4">
          {groupByDay(entries).map(([day, rows]) => (
            <section key={day}>
              <h4 className="sticky top-0 z-10 -mx-1 bg-surface/80 px-1 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted backdrop-blur">
                {day}
              </h4>
              <ol className="space-y-0.5">
                {rows.map((e) => <Row key={e.id} entry={e} sessionIndex={sessionIndex} />)}
              </ol>
            </section>
          ))}
          {hasNextPage ? (
            <div className="pt-1 text-center">
              <Button variant="ghost" size="sm" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
                Load older
              </Button>
            </div>
          ) : (
            // The server floors this query at the visibility window, so paging
            // simply runs out rather than reaching the end of the record. Say
            // which of the two happened — a list that just stops looks like
            // everything older is gone, and it is not.
            <p className="pt-2 text-center text-xs text-muted">
              Showing the last 7 days. Older activity is retained but not browsable here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ entry, sessionIndex }: { entry: TimelineEntry; sessionIndex: SessionEntryIndex }) {
  const src = sourceLabel(entry.source);
  const duration = formatDuration(entry.durationMs);
  const preview = entry.detail?.preview;
  const isSwitch = entry.action === "app.focus" || entry.action === "site.visit";
  // The correlated activity_sessions record for this exact row, when one
  // exists — see sessionEntryFor's doc comment for why the match is exact
  // rather than fuzzy. null for every non-switch row, and for a switch row
  // the sessionizer had nothing to correlate yet, which is the SAME as
  // today: every branch below falls back to the plain TimelineEntry fields.
  const session = isSwitch ? sessionEntryFor(entry, sessionIndex) : null;
  // "Learn Go in 30 Minutes" under "Switched to YouTube" — the page/window
  // title a desktop or browser sensor reported alongside the switch, now
  // preferring the correlated session's own copy when there is one (see
  // activityTitle). Absent on every row recorded before a producer sent one
  // — nothing renders in that case, which is the row's exact appearance
  // before this existed.
  const title = isSwitch ? activityTitle(entry, session) : null;
  // "blisswork/backend" for a GitHub row — ONLY ever present when the
  // sessionizer actually correlated a siteRef; never derived from the title
  // or guessed from the destination name.
  const enrichment = siteContext(session);
  const url = isSwitch ? activityUrl(entry, session) : null;
  // The raw reading behind a resolved name — "youtube.com" under "YouTube".
  // Shown only when it adds something: a row whose destination had no mapping
  // already displays the domain as its name, and repeating it underneath is
  // noise rather than detail. Also skipped when a `url` or `enrichment` line
  // is already showing the same information more precisely.
  const { to } = destinationOf(entry);
  const rawDestination = to && to !== entry.targetId ? entry.targetId : null;

  return (
    <li className="flex items-start gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
      <time
        className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-muted"
        dateTime={entry.occurredAt}
        title={new Date(entry.occurredAt).toLocaleString()}
      >
        {new Date(entry.occurredAt).toLocaleTimeString(undefined, {
          hour: "2-digit", minute: "2-digit",
        })}
      </time>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm text-fg">{actionLabel(entry, session)}</span>
          {duration && <Badge tone="neutral">{duration}</Badge>}
          {src.verified && (
            // Server-observed rows are derived from what the services actually
            // did. Marking them is not decoration: everything unmarked is the
            // member's own client reporting on itself.
            <span title="Recorded by BlissWork itself — not self-reported" className="text-success">
              <ShieldCheck size={13} />
            </span>
          )}
          {url && (
            // Opens through the same target="_blank" + rel="noopener noreferrer"
            // convention every other external link in this app uses (see
            // messageBody.tsx, LocationBubble.tsx) — on desktop this is
            // additionally intercepted and re-validated by harden.ts's
            // setWindowOpenHandler before anything is opened, the same
            // safety net every other in-app link already relies on. `url`
            // is only ever set from the RECORDED detail.url (see
            // activityUrl's doc comment) — never fabricated from a title or
            // destination name.
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-xs font-medium text-accent hover:underline"
            >
              <ExternalLink size={11} /> Open
            </a>
          )}
        </div>
        {preview && (
          <p className="mt-0.5 truncate text-sm text-muted" title={preview}>“{preview}”</p>
        )}
        {title && (
          <p className="mt-0.5 truncate text-sm text-muted" title={title}>{title}</p>
        )}
        {enrichment && (
          <p className="mt-0.5 truncate text-xs text-muted" title={enrichment}>{enrichment}</p>
        )}
        {!enrichment && (
          url ? (
            <p className="mt-0.5 truncate text-xs text-muted" title={url}>{url}</p>
          ) : (
            rawDestination && (
              <p className="mt-0.5 truncate text-xs text-muted">{rawDestination}</p>
            )
          )
        )}
      </div>
      <span className="shrink-0 pt-0.5 text-[11px] text-muted">{src.text}</span>
    </li>
  );
}

/** Group in ONE pass, relying on the server's newest-first order rather than
 *  re-sorting — the pages already arrive ordered, and re-sorting a growing
 *  infinite list on every render is work that compounds as the user scrolls. */
function groupByDay(entries: TimelineEntry[]): [string, TimelineEntry[]][] {
  const out: [string, TimelineEntry[]][] = [];
  for (const e of entries) {
    const day = dayHeading(e.occurredAt);
    const last = out[out.length - 1];
    if (last && last[0] === day) last[1].push(e);
    else out.push([day, [e]]);
  }
  return out;
}
