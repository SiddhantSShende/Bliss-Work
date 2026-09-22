import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ListTodo, Star, MessageSquarePlus } from "lucide-react";
import { Avatar, Badge, Button, GlassCard, EmptyState, Spinner } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useUserLabels } from "../lib/userLabel";
import {
  NO_SENT_FILTER,
  STATUS_FILTERS,
  filterSentTasks,
  isFiltering,
  markedDays,
  personOptions,
  type SentAssignee,
  type SentTaskFilter,
} from "../lib/sentTaskFilter";
import { CreateReviewDialog } from "./CreateReviewDialog";
import { MiniTaskCalendar } from "./MiniTaskCalendar";

/** Tasks fetched per request — the server's maximum page. */
const PAGE_SIZE = 100;

/** Format an ISO instant to the viewer's local date + time (or "" when absent). */
function fmtTs(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type BadgeTone = "success" | "accent" | "danger" | "neutral";
const statusTone = (s: string): BadgeTone =>
  s === "COMPLETED" ? "success" : s === "ACKNOWLEDGED" ? "accent" : s === "IGNORED" || s === "LEFT" ? "danger" : "neutral";

/** Toggle `value` in an immutable set. */
function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

export function MyTasksBoard() {
  const { api } = useRuntime();
  // A child of qk.sent: the realtime bridge's invalidate(qk.sent) prefix-matches
  // it, while TasksList/Search keep their own plain-array qk.sent cache.
  const sent = useInfiniteQuery({
    queryKey: [...qk.sent, "board"],
    queryFn: ({ pageParam }) => api.tasksSent({ limit: PAGE_SIZE, offset: pageParam, includeIgnored: true }),
    initialPageParam: 0,
    getNextPageParam: (last, all) =>
      last.length < PAGE_SIZE ? undefined : all.reduce((n, page) => n + page.length, 0),
  });
  const tasks = useMemo(() => sent.data?.pages.flat() ?? [], [sent.data]);
  const [filter, setFilter] = useState<SentTaskFilter>(NO_SENT_FILTER);
  const [reviewTarget, setReviewTarget] = useState<{ taskId: string; assignee: SentAssignee } | null>(null);

  const people = useMemo(() => personOptions(tasks), [tasks]);
  const { nameOf, avatarUrlOf } = useUserLabels(useMemo(() => people.map((p) => p.id), [people]));
  const visible = useMemo(() => filterSentTasks(tasks, filter), [tasks, filter]);
  const marks = useMemo(() => markedDays(tasks, filter), [tasks, filter]);

  // No data yet is not "no tasks": the first page is still loading, or failed.
  // Without this the empty state flashed on every visit (this board has its own
  // cache, so nothing is there to render from) and stayed after a failed load.
  if (!sent.data)
    return sent.isError ? (
      <div className="m-2 flex flex-col items-center gap-3 rounded-xl border border-border/60 p-6 text-center">
        <div className="text-sm font-medium text-fg">Couldn't load your tasks.</div>
        <Button size="sm" variant="secondary" onClick={() => void sent.refetch()}>
          Retry
        </Button>
      </div>
    ) : (
      <div className="flex items-center gap-2 p-4 text-sm text-muted">
        <Spinner /> Loading your tasks…
      </div>
    );
  if (tasks.length === 0)
    return <EmptyState icon={<ListTodo size={24} />} title="You haven't sent any tasks" hint="Create one with “New task”." />;

  return (
    <>
      <div className="grid items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <GlassCard className="p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Status</div>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_FILTERS.map((s) => {
                const on = filter.statuses.has(s);
                return (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setFilter({ ...filter, statuses: toggled(filter.statuses, s) })}
                    className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                      on ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg hover:bg-surface-2/70"
                    }`}
                  >
                    {s.toLowerCase()}
                  </button>
                );
              })}
            </div>
          </GlassCard>
          <GlassCard className="p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">People</div>
            <div className="flex max-h-64 flex-col gap-0.5 overflow-auto">
              {people.map((p) => {
                const on = filter.personIds.has(p.id);
                const name = nameOf(p.id, p.username);
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setFilter({ ...filter, personIds: toggled(filter.personIds, p.id) })}
                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                      on ? "bg-accent-soft text-accent" : "text-fg hover:bg-surface-2"
                    }`}
                  >
                    <Avatar name={name} src={avatarUrlOf(p.id)} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                  </button>
                );
              })}
            </div>
          </GlassCard>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <GlassCard className="flex justify-center p-3">
            <MiniTaskCalendar
              markedDays={marks}
              selectedDay={filter.day}
              onSelectDay={(day) => setFilter({ ...filter, day })}
            />
          </GlassCard>
          {isFiltering(filter) && (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setFilter(NO_SENT_FILTER)}>
                Clear filters
              </Button>
            </div>
          )}
          {visible.length === 0 ? (
            <EmptyState
              icon={<ListTodo size={24} />}
              title="No tasks match these filters"
              hint={sent.hasNextPage ? "Older tasks aren't loaded yet — load more below." : undefined}
            />
          ) : (
            <div className="grid gap-3">
              {visible.map(({ task: t, assignees }) => (
                <GlassCard key={t.taskId} className="p-4">
                  <div className="font-semibold text-fg">{t.title}</div>
                  {t.description && <p className="mt-1 text-sm text-muted">{t.description}</p>}
                  <div className="mt-3 flex flex-col divide-y divide-border/50">
                    {assignees.map((a) => (
                      <AssigneeTimeline
                        key={a.assigneeId}
                        assignee={a}
                        onReview={() => setReviewTarget({ taskId: t.taskId, assignee: a })}
                      />
                    ))}
                  </div>
                </GlassCard>
              ))}
            </div>
          )}
          {sent.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" size="sm" disabled={sent.isFetchingNextPage} onClick={() => void sent.fetchNextPage()}>
                {sent.isFetchingNextPage ? "Loading…" : "Load older tasks"}
              </Button>
            </div>
          )}
        </div>
      </div>
      {reviewTarget && (
        <CreateReviewDialog
          open={!!reviewTarget}
          onClose={() => setReviewTarget(null)}
          taskId={reviewTarget.taskId}
          assigneeId={reviewTarget.assignee.assigneeId}
          assigneeName={reviewTarget.assignee.assigneeUsername}
          existingText={reviewTarget.assignee.review}
          existingRating={reviewTarget.assignee.reviewRating}
        />
      )}
    </>
  );
}

/** One assignee's status + full timeline + the review the allocator left. */
function AssigneeTimeline({ assignee: a, onReview }: { assignee: SentAssignee; onReview: () => void }) {
  const milestones = [
    { label: "Allocated", at: a.assignedAt },
    { label: "Acknowledged", at: a.acknowledgedAt },
    { label: "Ignored", at: a.ignoredAt },
    { label: "Completed", at: a.completedAt },
    { label: "Left", at: a.leftAt },
    { label: "Reviewed", at: a.reviewedAt },
  ].filter((m) => m.at);

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-fg">
          {a.assigneeUsername}
          <Badge tone={statusTone(a.status)}>{a.status.toLowerCase()}</Badge>
        </span>
        {a.status === "COMPLETED" && (
          <Button variant="ghost" size="sm" onClick={onReview}>
            <MessageSquarePlus size={14} /> {a.review ? "Edit review" : "Write review"}
          </Button>
        )}
      </div>
      {milestones.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          {milestones.map((m) => (
            <span key={m.label}>
              <span className="text-fg/70">{m.label}</span> {fmtTs(m.at)}
            </span>
          ))}
        </div>
      )}
      {a.review && (
        <div className="mt-2 rounded-lg bg-surface-2/60 p-2.5 text-sm">
          {a.reviewRating != null && (
            <div className="mb-1 flex items-center gap-0.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <Star
                  key={n}
                  size={14}
                  className={n <= a.reviewRating! ? "fill-amber-400 text-amber-400" : "text-muted/40"}
                />
              ))}
            </div>
          )}
          <p className="whitespace-pre-wrap text-muted">{a.review}</p>
        </div>
      )}
    </div>
  );
}
