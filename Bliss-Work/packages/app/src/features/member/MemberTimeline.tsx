import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Activity, ShieldCheck } from "lucide-react";
import { Badge, Button, EmptyState, Spinner } from "@taskboard/ui";
import type { TimelineEntry } from "@taskboard/shared";
import { useRuntime } from "../../lib/runtime";
import { qk } from "../../lib/queryBridge";
import { Tabs, type TabSpec } from "../Tabs";
import {
  actionLabel,
  activityTitle,
  collapseSwitches,
  dayHeading,
  destinationOf,
  formatDuration,
  sourceLabel,
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
                {rows.map((e) => <Row key={e.id} entry={e} />)}
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

function Row({ entry }: { entry: TimelineEntry }) {
  const src = sourceLabel(entry.source);
  const duration = formatDuration(entry.durationMs);
  const preview = entry.detail?.preview;
  const url = entry.detail?.url;
  // "Learn Go in 30 Minutes" under "Switched to YouTube" — the page/window
  // title a desktop or browser sensor reported alongside the switch. Absent on
  // every row recorded before a producer sent one; nothing renders in that
  // case, which is the row's exact appearance today.
  const title = (entry.action === "app.focus" || entry.action === "site.visit")
    ? activityTitle(entry)
    : null;
  // The raw reading behind a resolved name — "youtube.com" under "YouTube".
  // Shown only when it adds something: a row whose destination had no mapping
  // already displays the domain as its name, and repeating it underneath is
  // noise rather than detail.
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
          <span className="text-sm text-fg">{actionLabel(entry)}</span>
          {duration && <Badge tone="neutral">{duration}</Badge>}
          {src.verified && (
            // Server-observed rows are derived from what the services actually
            // did. Marking them is not decoration: everything unmarked is the
            // member's own client reporting on itself.
            <span title="Recorded by BlissWork itself — not self-reported" className="text-success">
              <ShieldCheck size={13} />
            </span>
          )}
        </div>
        {preview && (
          <p className="mt-0.5 truncate text-sm text-muted" title={preview}>“{preview}”</p>
        )}
        {title && (
          <p className="mt-0.5 truncate text-sm text-muted" title={title}>{title}</p>
        )}
        {url ? (
          <p className="mt-0.5 truncate text-xs text-muted" title={url}>{url}</p>
        ) : (
          rawDestination && (
            <p className="mt-0.5 truncate text-xs text-muted">{rawDestination}</p>
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
