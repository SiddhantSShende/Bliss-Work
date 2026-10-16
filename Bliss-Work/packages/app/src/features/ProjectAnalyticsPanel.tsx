import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { Badge, Button, EmptyState, Spinner } from "@taskboard/ui";
import type { ProjectTaskStatus, ProjectTaskSummaryDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryKeys";
import { formatTaskInstant } from "../lib/taskDates";
import { useUserLabels } from "../lib/userLabel";
import {
  CompletionRing,
  KpiTile,
  StatusBreakdownBar,
  WorkloadBars,
} from "./TaskAnalyticsParts";

const PAGE_SIZE = 20;

/**
 * Snapshot analytics across every task IN a project (tasks.projectId): the
 * same completion metrics and per-assignee workload ChannelAnalyticsPanel
 * renders for a channel's task_channels, plus an overdue count and a
 * paginated per-task breakdown (title, assignees, dates, deadline, status)
 * that a channel's aggregate-only view has no equivalent of.
 *
 * Deliberately a SEPARATE panel rather than a mode of ChannelAnalyticsPanel:
 * a project's own auto-created channel is never a task assignment target
 * (see projects.py), so project membership and task data live behind two
 * different ids and two different queries — mixing them into one component
 * would conflate the two data models the task description warned against.
 */
export function ProjectAnalyticsPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: qk.projectAnalytics(projectId),
      queryFn: ({ pageParam }) => api.projectAnalytics(projectId, { limit: PAGE_SIZE, offset: pageParam }),
      initialPageParam: 0,
      getNextPageParam: (last) => {
        const loaded = last.tasksOffset + last.tasks.length;
        return loaded < last.tasksTotal ? loaded : undefined;
      },
    });

  // `assigneeUsername`/`senderUsername` are email-derived handles, not
  // display names (see userLabel.ts). Every id this panel will ever render
  // — workload assignees, task senders, per-task assignees, across every
  // loaded page — is already in hand, so resolve them all through one
  // directory lookup instead of rendering the raw DTO fields.
  const allIds = useMemo(() => {
    const ids = new Set<string>();
    for (const page of data?.pages ?? []) {
      for (const w of page.workload) ids.add(w.assigneeId);
      for (const task of page.tasks) {
        ids.add(task.senderId);
        for (const a of task.assignees) ids.add(a.assigneeId);
      }
    }
    return [...ids];
  }, [data?.pages]);
  const { nameOf } = useUserLabels(allIds);

  if (isLoading) {
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  }
  // The first page already carries the whole project's aggregate metrics
  // (see task-svc's project_analytics) — every later page repeats the same
  // aggregate alongside its own slice of `tasks`, so only page 0 is read here.
  const first = data?.pages[0];
  if (isError || !first) {
    return (
      <div className="space-y-2">
        <EmptyState icon={<BarChart3 size={22} />} title={t("tasks:analytics.error")} hint="" />
        <div className="flex justify-center">
          <Button variant="subtle" size="sm" onClick={() => void refetch()}>
            {t("tasks:analytics.project.retry")}
          </Button>
        </div>
      </div>
    );
  }
  if (first.completion.totalUniqueTasks === 0) {
    return (
      <EmptyState
        icon={<BarChart3 size={22} />}
        title={t("tasks:analytics.project.emptyTitle")}
        hint={t("tasks:analytics.project.emptyHint")}
      />
    );
  }

  const tasks = data.pages.flatMap((page) => page.tasks);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile label={t("tasks:analytics.project.totalTasks")} value={String(first.completion.totalUniqueTasks)} />
        <KpiTile label={t("tasks:analytics.project.completedTasks")} value={String(first.completion.completedUniqueTasks)} />
        <KpiTile label={t("tasks:analytics.project.overdueTasks")} value={String(first.overdueUniqueTasks)} />
        <KpiTile label={t("tasks:analytics.project.remainingTasks")} value={String(first.completion.remainingUniqueTasks)} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <KpiTile
          label={t("tasks:analytics.completion.assignmentRate")}
          value={`${Math.round(first.completion.assignmentCompletionRate)}%`}
          hint={`${first.completion.completedAssignments}/${first.completion.totalAssignments}`}
          tooltip={t("tasks:analytics.completion.assignmentRateTooltip")}
        />
        <div title={t("tasks:analytics.completion.uniqueRateTooltip")}>
          <CompletionRing percent={first.completion.uniqueTaskCompletionRate} label={t("tasks:analytics.completion.uniqueRate")} />
        </div>
      </div>

      <StatusBreakdownBar breakdown={first.statusBreakdown} />

      <div>
        <h4 className="mb-2 text-sm font-semibold text-fg">{t("tasks:analytics.project.workloadHeading")}</h4>
        <WorkloadBars workload={first.workload} nameOf={nameOf} />
      </div>

      <div>
        <h4 className="mb-2 text-sm font-semibold text-fg">{t("tasks:analytics.project.breakdownHeading")}</h4>
        <ProjectTaskBreakdownList tasks={tasks} nameOf={nameOf} />
        {hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button variant="subtle" size="sm" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
              {isFetchingNextPage ? <Spinner className="h-4 w-4" /> : t("tasks:analytics.project.loadMore")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

const TASK_STATUS_TONE: Record<ProjectTaskStatus, "success" | "accent" | "warning"> = {
  COMPLETED: "success",
  IN_PROGRESS: "accent",
  ABANDONED: "warning",
};

function ProjectTaskBreakdownList({
  tasks,
  nameOf,
}: {
  tasks: ProjectTaskSummaryDTO[];
  nameOf: (id: string, fallback?: string) => string;
}) {
  const { t } = useTranslation("tasks");
  return (
    <ul className="m-0 list-none space-y-2 p-0">
      {tasks.map((task) => (
        <li key={task.taskId} className="rounded-xl border border-border/60 p-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-fg" title={task.title}>
              {task.title}
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              {task.overdue && <Badge tone="danger">{t("tasks:analytics.project.overdueBadge")}</Badge>}
              <Badge tone={TASK_STATUS_TONE[task.taskStatus]}>{t(`tasks:analytics.project.taskStatus.${task.taskStatus}`)}</Badge>
            </div>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
            <span>{t("tasks:analytics.project.sentBy", { name: nameOf(task.senderId, task.senderUsername) })}</span>
            {formatTaskInstant(task.createdAt) && <span>{t("tasks:analytics.project.createdOn", { date: formatTaskInstant(task.createdAt) })}</span>}
            {task.deadlineAt && formatTaskInstant(task.deadlineAt) && (
              <span>{t("tasks:analytics.project.deadlineOn", { date: formatTaskInstant(task.deadlineAt) })}</span>
            )}
          </div>
          {task.assignees.length > 0 && (
            <ul className="mt-2 flex min-w-0 flex-wrap gap-1.5">
              {task.assignees.map((assignee) => (
                <li key={assignee.assigneeId} className="inline-flex min-w-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-fg">
                  <span className="max-w-32 truncate">{nameOf(assignee.assigneeId, assignee.assigneeUsername)}</span>
                  <span className="text-muted">{t(`tasks:analytics.statuses.${assignee.status.toLowerCase()}`)}</span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
