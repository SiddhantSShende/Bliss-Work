import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Activity, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Badge, EmptyState, Spinner } from "@taskboard/ui";
import type { TimelineEntry } from "@taskboard/shared";
import { useRuntime } from "../../lib/runtime";
import { qk } from "../../lib/queryBridge";
import { Tabs, type TabSpec } from "../Tabs";
import { actionLabel, dayHeading, formatDuration, sourceLabel } from "./activityLabels";
import { LoadOlderFooter } from "./LoadOlderFooter";

type Filter = "all" | "auth" | "engagement" | "navigation" | "security";

function filters(t: TFunction): TabSpec<Filter>[] {
  return [
    { key: "all", label: t("members:timeline.filters.all") },
    { key: "engagement", label: t("members:timeline.filters.engagement") },
    { key: "navigation", label: t("members:timeline.filters.navigation") },
    { key: "auth", label: t("members:timeline.filters.auth") },
    // Client-enforced controls the person ran into — today, refused screen
    // captures. Self-reported by definition: a screenshot happens in the
    // operating system, so this is what the app SAW and refused, not proof
    // that nothing was captured.
    { key: "security", label: t("members:timeline.filters.security") },
  ];
}

/**
 * One member's activity, newest first, grouped by day.
 *
 * `userId` may be the literal "me" — the server resolves the subject, so this
 * exact component renders both the admin's view of someone else and a member's
 * view of their own record. One component, one code path, no chance of the
 * self-view accidentally showing something the admin view does not.
 */
export function MemberTimeline({ userId }: { userId: string }) {
  const { t, i18n } = useTranslation("members");
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

  const entries = data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <div className="space-y-4">
      <Tabs tabs={filters(t)} active={filter} onChange={setFilter} />

      {isLoading ? (
        <div className="flex justify-center p-8"><Spinner /></div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<Activity size={22} />}
          title={t("members:timeline.empty.title")}
          hint={t("members:timeline.empty.hint", { brand: "BlissWork" })}
        />
      ) : (
        <div className="space-y-4">
          {groupByDay(entries, t, i18n.language).map(([day, rows]) => (
            <section key={day}>
              <h4 className="sticky top-0 z-10 -mx-1 bg-surface/80 px-1 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted backdrop-blur">
                {day}
              </h4>
              <ol className="space-y-0.5">
                {rows.map((e) => <Row key={e.id} entry={e} />)}
              </ol>
            </section>
          ))}
          <LoadOlderFooter
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            onLoadMore={() => fetchNextPage()}
            className="pt-1 text-center"
          >
            {/* The server floors this query at the visibility window, so paging
                simply runs out rather than reaching the end of the record. Say
                which of the two happened — a list that just stops looks like
                everything older is gone, and it is not. */}
            <p className="pt-2 text-center text-xs text-muted">
              {t("members:timeline.retentionNote")}
            </p>
          </LoadOlderFooter>
        </div>
      )}
    </div>
  );
}

function Row({ entry }: { entry: TimelineEntry }) {
  const { t, i18n } = useTranslation("members");
  const src = sourceLabel(entry.source, t);
  const duration = formatDuration(entry.durationMs);
  const preview = entry.detail?.preview;

  return (
    <li className="flex items-start gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
      <time
        className="w-16 shrink-0 pt-0.5 text-xs tabular-nums text-muted"
        dateTime={entry.occurredAt}
        title={new Date(entry.occurredAt).toLocaleString(i18n.language)}
      >
        {new Date(entry.occurredAt).toLocaleTimeString(i18n.language, {
          hour: "2-digit", minute: "2-digit",
        })}
      </time>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm text-fg">{actionLabel(entry, t)}</span>
          {duration && <Badge tone="neutral">{duration}</Badge>}
          {src.verified && (
            // Server-observed rows are derived from what the services actually
            // did. Marking them is not decoration: everything unmarked is the
            // member's own client reporting on itself.
            <span title={t("members:timeline.verifiedTooltip", { brand: "BlissWork" })} className="text-success">
              <ShieldCheck size={13} />
            </span>
          )}
        </div>
        {preview && (
          <p className="mt-0.5 truncate text-sm text-muted" title={preview}>“{preview}”</p>
        )}
      </div>
      <span className="shrink-0 pt-0.5 text-[11px] text-muted">{src.text}</span>
    </li>
  );
}

/** Group in ONE pass, relying on the server's newest-first order rather than
 *  re-sorting — the pages already arrive ordered, and re-sorting a growing
 *  infinite list on every render is work that compounds as the user scrolls. */
function groupByDay(entries: TimelineEntry[], t: TFunction, lang: string): [string, TimelineEntry[]][] {
  const out: [string, TimelineEntry[]][] = [];
  for (const e of entries) {
    const day = dayHeading(e.occurredAt, t, lang);
    const last = out[out.length - 1];
    if (last && last[0] === day) last[1].push(e);
    else out.push([day, [e]]);
  }
  return out;
}
