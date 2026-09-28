import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ListTodo, Star, MessageSquarePlus, CalendarClock } from "lucide-react";
import { Avatar, Badge, Button, GlassCard, EmptyState, Spinner, Input } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useUserLabels } from "../lib/userLabel";
import { useSession } from "../store/session";
import { TaskParticipants } from "./TaskParticipants";
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
const VISIBLE_BATCH_SIZE = 4;

/** Format an ISO instant to the viewer's local date + time (or "" when absent).
 *  `lang` is the in-app selected locale (i18n.language) so this follows the
 *  language switcher rather than only the browser's own locale. */
function fmtTs(iso?: string | null, lang?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(lang, {
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
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const currentUserId = useSession((s) => s.user?.id) ?? "";
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
  const schedules = useQuery({ queryKey: [...qk.sent, "schedules"], queryFn: () => api.taskSchedules() });
  const [filter, setFilter] = useState<SentTaskFilter>(NO_SENT_FILTER);
  const [visibleCount, setVisibleCount] = useState(VISIBLE_BATCH_SIZE);
  const [reviewTarget, setReviewTarget] = useState<{ taskId: string; assignee: SentAssignee } | null>(null);
  const membership = useMutation({
    mutationFn: ({ taskId, userIds }: { taskId: string; userIds: string[] }) => api.addTaskParticipants(taskId, userIds),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.sent }),
    onError: (err) => toast.error(t("participants.failed"), { description: String(err) }),
  });
  const withdrawal = useMutation({
    mutationFn: ({ taskId, userId }: { taskId: string; userId: string }) => api.withdrawTaskParticipant(taskId, userId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.sent }),
    onError: (err) => toast.error(t("participants.failed"), { description: String(err) }),
  });

  const people = useMemo(() => personOptions(tasks), [tasks]);
  const { nameOf, avatarUrlOf } = useUserLabels(useMemo(() => people.map((p) => p.id), [people]));
  const visible = useMemo(() => filterSentTasks(tasks, filter), [tasks, filter]);
  const visibleSchedules = filter.statuses.has("SCHEDULED") ? schedules.data ?? [] : [];
  const visibleTasks = useMemo(() => visible.slice(0, visibleCount), [visible, visibleCount]);
  const marks = useMemo(() => markedDays(tasks, filter), [tasks, filter]);

  useEffect(() => {
    setVisibleCount(VISIBLE_BATCH_SIZE);
  }, [filter]);

  const loadMore = async () => {
    const nextCount = visibleCount + VISIBLE_BATCH_SIZE;
    if (nextCount > visible.length && sent.hasNextPage) {
      await sent.fetchNextPage();
    }
    setVisibleCount(nextCount);
  };

  // No data yet is not "no tasks": the first page is still loading, or failed.
  // Without this the empty state flashed on every visit (this board has its own
  // cache, so nothing is there to render from) and stayed after a failed load.
  if (!sent.data)
    return sent.isError ? (
      <div className="m-2 flex flex-col items-center gap-3 rounded-xl border border-border/60 p-6 text-center">
        <div className="text-sm font-medium text-fg">{t("myTasksBoard.loadError.title")}</div>
        <Button size="sm" variant="secondary" onClick={() => void sent.refetch()}>
          {t("myTasksBoard.loadError.retry")}
        </Button>
      </div>
    ) : (
      <div className="flex items-center gap-2 p-4 text-sm text-muted">
        <Spinner /> {t("myTasksBoard.loading")}
      </div>
    );
  if (tasks.length === 0 && schedules.isPending)
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted">
        <Spinner /> {t("myTasksBoard.loading")}
      </div>
    );
  if (tasks.length === 0 && schedules.data && schedules.data.length === 0)
    return (
      <EmptyState
        icon={<ListTodo size={24} />}
        title={t("myTasksBoard.empty.title")}
        hint={t("myTasksBoard.empty.hint")}
      />
    );

  return (
    <>
      <div className="grid items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <GlassCard className="p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t("myTasksBoard.filters.statusHeading")}</div>
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
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t("myTasksBoard.filters.peopleHeading")}</div>
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
                {t("myTasksBoard.filters.clear")}
              </Button>
            </div>
          )}
          {visible.length === 0 && visibleSchedules.length === 0 ? (
            <EmptyState
              icon={<ListTodo size={24} />}
              title={t("myTasksBoard.noMatch.title")}
              hint={sent.hasNextPage ? t("myTasksBoard.noMatch.hint") : undefined}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {visibleSchedules.map((schedule) => (
                <ScheduledTaskCard key={schedule.scheduleId} schedule={schedule} onCancelled={() => void schedules.refetch()} />
              ))}
              {visibleTasks.map(({ task: t, assignees }) => (
                <GlassCard key={t.taskId} className="flex min-w-0 flex-col p-4">
                  <div className="flex min-w-0 items-start gap-2">
                    <div className="min-w-0 flex-1 line-clamp-2 break-words font-semibold text-fg">{t.title}</div>
                  </div>
                  {t.description && <p className="mt-1 min-w-0 line-clamp-3 break-words text-sm text-muted">{t.description}</p>}
                  <TaskParticipants
                    participants={t.participants ?? assignees.map((a) => ({ userId: a.assigneeId, username: a.assigneeUsername, status: a.status }))}
                    currentUserId={currentUserId}
                    allocatorId={currentUserId}
                    layout="list"
                    onAdd={(userIds) => membership.mutateAsync({ taskId: t.taskId, userIds }).then(() => undefined)}
                    onWithdraw={(userId) => withdrawal.mutateAsync({ taskId: t.taskId, userId }).then(() => undefined)}
                  />
                  <div className="mt-3 flex min-w-0 flex-col divide-y divide-border/50">
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
          {(visibleCount < visible.length || sent.hasNextPage) && (
            <div className="flex justify-center">
              <Button variant="secondary" size="sm" disabled={sent.isFetchingNextPage} onClick={() => void loadMore()}>
                {sent.isFetchingNextPage ? t("myTasksBoard.loadingMore") : t("myTasksBoard.loadMore")}
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

function ScheduledTaskCard({
  schedule,
  onCancelled,
}: {
  schedule: import("@taskboard/shared").ScheduledTaskDTO;
  onCancelled: () => void;
}) {
  const { t, i18n } = useTranslation("tasks");
  const { api } = useRuntime();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(() => {
    const value = new Date(schedule.nextRunAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelTaskSchedule(schedule.scheduleId),
    onSuccess: onCancelled,
    onError: (error) => toast.error(String(error)),
  });
  const update = useMutation({
    mutationFn: () => api.updateTaskSchedule(schedule.scheduleId, new Date(editValue).toISOString()),
    onSuccess: () => {
      setEditing(false);
      onCancelled();
    },
    onError: (error) => toast.error(String(error)),
  });
  const date = new Date(schedule.nextRunAt).toLocaleString(i18n.language, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const recurrence = schedule.kind === "RECURRING"
    ? `${schedule.frequency?.toLowerCase()} · ${schedule.interval ?? 1}x`
    : null;
  return (
    <GlassCard className="flex min-w-0 flex-col p-4">
      <div className="flex min-w-0 items-start gap-2">
        <CalendarClock size={17} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 break-words font-semibold text-fg">{schedule.title}</div>
          <div className="mt-1 text-xs font-medium uppercase tracking-wide text-accent">{t("myTasksBoard.scheduled")}</div>
          {editing ? (
            <Input type="datetime-local" value={editValue} min={new Date().toISOString().slice(0, 16)} onChange={(event) => setEditValue(event.target.value)} />
          ) : (
            <div className="mt-1 text-sm text-muted">{date}</div>
          )}
          {recurrence && <div className="mt-1 text-xs text-muted">{recurrence}</div>}
          {schedule.assignees.length > 0 && (
            <div className="mt-2 line-clamp-2 break-words text-sm text-fg">{schedule.assignees.map((assignee) => assignee.username).join(", ")}</div>
          )}
          {schedule.assignees.length === 0 && schedule.channelId && (
            <div className="mt-2 text-sm text-fg">Channel assignment</div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {editing ? (
              <>
                <Button variant="secondary" size="sm" disabled={update.isPending} onClick={() => update.mutate()}>Save</Button>
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button>
            )}
            <Button variant="ghost" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              {schedule.kind === "RECURRING" ? t("myTasksBoard.cancelRecurring") : t("myTasksBoard.cancelSchedule")}
            </Button>
          </div>
        </div>
      </div>
    </GlassCard>
  );
}

/** One assignee's status + full timeline + the review the allocator left. */
function AssigneeTimeline({ assignee: a, onReview }: { assignee: SentAssignee; onReview: () => void }) {
  const { t, i18n } = useTranslation("tasks");
  const milestones = [
    { label: t("myTasksBoard.milestones.allocated"), at: a.assignedAt },
    { label: t("myTasksBoard.milestones.acknowledged"), at: a.acknowledgedAt },
    { label: t("myTasksBoard.milestones.ignored"), at: a.ignoredAt },
    { label: t("myTasksBoard.milestones.completed"), at: a.completedAt },
    { label: t("myTasksBoard.milestones.left"), at: a.leftAt },
    { label: t("myTasksBoard.milestones.reviewed"), at: a.reviewedAt },
  ].filter((m) => m.at);

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium text-fg">
          <span className="min-w-0 truncate">{a.assigneeUsername}</span>
          <Badge tone={statusTone(a.status)}>{a.status.toLowerCase()}</Badge>
        </span>
        {a.status === "COMPLETED" && (
          <Button variant="ghost" size="sm" className="shrink-0" onClick={onReview}>
            <MessageSquarePlus size={14} /> {a.review ? t("myTasksBoard.review.edit") : t("myTasksBoard.review.write")}
          </Button>
        )}
      </div>
      {milestones.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          {milestones.map((m) => (
            <span key={m.label}>
              <span className="text-fg/70">{m.label}</span> {fmtTs(m.at, i18n.language)}
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
