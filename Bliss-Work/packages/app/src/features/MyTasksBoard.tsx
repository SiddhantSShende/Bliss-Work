import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ListTodo, CalendarClock } from "lucide-react";
import { Button, GlassCard, EmptyState, Spinner, Input } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useUserLabels } from "../lib/userLabel";
import { useSession } from "../store/session";
import type { ParticipantTargets } from "./AddParticipantsPicker";
import {
  NO_SENT_FILTER,
  filterSentTasks,
  markedDays,
  personOptions,
  type SentAssignee,
  type SentTaskFilter,
} from "../lib/sentTaskFilter";
import { describeDeadlineRule } from "../lib/taskDates";
import { CreateReviewDialog } from "./CreateReviewDialog";
import { TaskTimes } from "./TaskTimes";
import { MiniTaskCalendar } from "./MiniTaskCalendar";
import { MyTaskCard } from "./MyTaskCard";
import { MyTasksFilters } from "./MyTasksFilters";
import { useChannelMemberIds } from "./useChannelMemberIds";
import { useMySentTasks } from "./useMySentTasks";

const VISIBLE_BATCH_SIZE = 4;

export function MyTasksBoard({ projectId }: { projectId?: string } = {}) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const currentUserId = useSession((s) => s.user?.id) ?? "";
  const { sent, tasks } = useMySentTasks();
  const schedules = useQuery({ queryKey: [...qk.sent, "schedules"], queryFn: () => api.taskSchedules() });
  const [filter, setFilter] = useState<SentTaskFilter>(NO_SENT_FILTER);
  const [visibleCount, setVisibleCount] = useState(VISIBLE_BATCH_SIZE);
  const [reviewTarget, setReviewTarget] = useState<{ taskId: string; assignee: SentAssignee } | null>(null);
  const membership = useMutation({
    mutationFn: ({ taskId, targets }: { taskId: string; targets: ParticipantTargets }) => api.addTaskParticipants(taskId, targets),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: qk.sent });
      if (result.projectChannelSyncFailed) toast.error(t("projects.syncFailed"));
    },
    onError: (err) => toast.error(t("participants.failed"), { description: String(err) }),
  });
  const withdrawal = useMutation({
    mutationFn: ({ taskId, userId }: { taskId: string; userId: string }) => api.withdrawTaskParticipant(taskId, userId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.sent }),
    onError: (err) => toast.error(t("participants.failed"), { description: String(err) }),
  });

  const boardTasks = useMemo(
    () => projectId ? tasks.filter((task) => task.projectId === projectId) : tasks,
    [projectId, tasks],
  );
  const people = useMemo(() => personOptions(boardTasks), [boardTasks]);
  // Cards also draw task.participants, who need not be assignees.
  const labelIds = useMemo(
    () => [...new Set([...people.map((p) => p.id), ...boardTasks.flatMap((task) => task.participants?.map((p) => p.userId) ?? [])])],
    [people, boardTasks],
  );
  const { nameOf, avatarUrlOf } = useUserLabels(labelIds);
  const channelList = useQuery({ queryKey: qk.channels, queryFn: () => api.channels() });
  const { members: channelMembers, retry: retryChannel } = useChannelMemberIds(filter.channelIds);
  const visible = useMemo(
    () => filterSentTasks(boardTasks, projectId ? NO_SENT_FILTER : filter, channelMembers),
    [boardTasks, filter, projectId, channelMembers],
  );
  const visibleSchedules = useMemo(() => {
    const rows = schedules.data ?? [];
    return projectId
      ? rows.filter((schedule) => schedule.projectId === projectId)
      : filter.statuses.has("SCHEDULED") ? rows : [];
  }, [filter.statuses, projectId, schedules.data]);
  const visibleTasks = useMemo(() => visible.slice(0, visibleCount), [visible, visibleCount]);
  const marks = useMemo(() => markedDays(boardTasks, filter, channelMembers), [boardTasks, filter, channelMembers]);

  useEffect(() => {
    setVisibleCount(VISIBLE_BATCH_SIZE);
  }, [filter, projectId]);

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
  if (boardTasks.length === 0 && schedules.isPending)
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted">
        <Spinner /> {t("myTasksBoard.loading")}
      </div>
    );
  if (boardTasks.length === 0 && schedules.data && visibleSchedules.length === 0 && !sent.hasNextPage)
    return (
      <EmptyState
        icon={<ListTodo size={24} />}
        title={projectId ? t("projects.noTasks") : t("myTasksBoard.empty.title")}
        hint={projectId ? undefined : t("myTasksBoard.empty.hint")}
      />
    );

  return (
    <>
      <div className="flex flex-col gap-4">
        {/* Filters and calendar share a row, and the calendar stretches to the
            filters' height. The cards below start under BOTH, never beside either. */}
        {!projectId && (
        <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <MyTasksFilters filter={filter} onChange={setFilter} people={people} nameOf={nameOf} avatarUrlOf={avatarUrlOf} channels={channelList.data} channelMembers={channelMembers} onRetryChannel={retryChannel} />
          <GlassCard className="flex min-w-0 flex-col p-4">
            <MiniTaskCalendar
              markedDays={marks}
              selectedDay={filter.day}
              onSelectDay={(day) => setFilter({ ...filter, day })}
            />
          </GlassCard>
        </div>
        )}

        {visible.length === 0 && visibleSchedules.length === 0 && !sent.hasNextPage ? (
          <EmptyState
            icon={<ListTodo size={24} />}
            title={projectId ? t("projects.noTasks") : t("myTasksBoard.noMatch.title")}
            hint={!projectId && sent.hasNextPage ? t("myTasksBoard.noMatch.hint") : undefined}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {visibleSchedules.map((schedule) => (
              <ScheduledTaskCard key={schedule.scheduleId} schedule={schedule} onCancelled={() => void schedules.refetch()} />
            ))}
            {visibleTasks.map((match) => (
              <MyTaskCard
                key={match.task.taskId}
                match={match}
                currentUserId={currentUserId}
                nameOf={nameOf}
                avatarUrlOf={avatarUrlOf}
                onReview={(assignee) => setReviewTarget({ taskId: match.task.taskId, assignee })}
                onAdd={(taskId, targets) => membership.mutateAsync({ taskId, targets }).then(() => undefined)}
                onWithdraw={(taskId, userId) => withdrawal.mutateAsync({ taskId, userId }).then(() => undefined)}
              />
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
  // Names where the caller can still see the channel; a count when any is not
  // (they left it, or it is gone) — never a silently shorter list.
  const { data: channelList } = useQuery({ queryKey: qk.channels, queryFn: () => api.channels() });
  const channelNames = schedule.channelIds.map((id) => channelList?.find((c) => c.id === id)?.name);
  const channelsLine = channelNames.every((name) => name !== undefined)
    ? t("myTasksBoard.scheduledChannels", { names: channelNames.map((name) => `#${name}`).join(", ") })
    : t("myTasksBoard.scheduledChannelCount", { count: schedule.channelIds.length });
  const recurrence = schedule.kind === "RECURRING"
    ? `${schedule.frequency?.toLowerCase()} · ${schedule.interval ?? 1}x`
    : null;
  return (
    <GlassCard data-testid="task-card" className="flex min-w-0 flex-col p-3">
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
          {/* A one-off schedule has its absolute deadline; a series has the rule each
              occurrence's deadline is worked out from. Neither ⇒ nothing is shown. */}
          {schedule.deadlineAt && <TaskTimes deadlineAt={schedule.deadlineAt} className="mt-2" />}
          {schedule.deadlineRule && (
            <div className="mt-1 break-words text-xs text-muted">
              {t("deadline.label")}: {describeDeadlineRule(schedule.deadlineRule)}
            </div>
          )}
          {schedule.assignees.length > 0 && (
            <div className="mt-2 line-clamp-2 break-words text-sm text-fg">{schedule.assignees.map((assignee) => assignee.username).join(", ")}</div>
          )}
          {schedule.channelIds.length > 0 && (
            <div className="mt-2 line-clamp-2 break-words text-sm text-fg">{channelsLine}</div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {editing ? (
              <>
                <Button variant="secondary" size="sm" disabled={update.isPending} onClick={() => update.mutate()}>{t("common:buttons.save")}</Button>
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>{t("common:buttons.cancel")}</Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>{t("common:buttons.edit")}</Button>
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
