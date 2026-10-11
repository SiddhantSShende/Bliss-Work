import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { EmptyState, Spinner } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryKeys";
import { formatMs } from "../i18n/format";
import { KpiTile, StatusBreakdownBar } from "./TaskAnalyticsParts";

/**
 * Snapshot analytics for one task: status breakdown across its assignees, a
 * per-assignee timeline, and the two completion metrics (see
 * TaskAnalyticsDTO / the "never conflate the two rates" rule). For a single
 * task the unique-task rate is a degenerate 0/1 case, but it is rendered with
 * the same KpiTile shape ChannelAnalyticsPanel uses, so the two stay visually
 * consistent if this panel is ever reused in a multi-task context.
 */
export function TaskAnalyticsPanel({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation("tasks");
  const { api } = useRuntime();
  const { data, isLoading, isError } = useQuery({
    queryKey: qk.taskAnalytics(taskId),
    queryFn: () => api.taskAnalytics(taskId),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <EmptyState
        icon={<BarChart3 size={22} />}
        title={t("tasks:analytics.error")}
        hint=""
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile
          label={t("tasks:analytics.completion.assignmentRate")}
          value={`${Math.round(data.completion.assignmentCompletionRate)}%`}
          hint={`${data.completion.completedAssignments}/${data.completion.totalAssignments}`}
          tooltip={t("tasks:analytics.completion.assignmentRateTooltip")}
        />
        <KpiTile
          label={t("tasks:analytics.completion.uniqueRate")}
          value={`${Math.round(data.completion.uniqueTaskCompletionRate)}%`}
          tooltip={t("tasks:analytics.completion.uniqueRateTooltip")}
        />
        <KpiTile
          label={t("tasks:analytics.task.assigneesHeading")}
          value={String(data.assignees.length)}
        />
        <KpiTile
          label={t("tasks:analytics.statuses.completed")}
          value={String(data.statusBreakdown.completed)}
        />
      </div>

      <StatusBreakdownBar breakdown={data.statusBreakdown} />

      <div>
        <h4 className="mb-2 text-sm font-semibold text-fg">
          {t("tasks:analytics.task.assigneesHeading")}
        </h4>
        <ul className="m-0 list-none space-y-2 p-0">
          {data.assignees.map((a) => (
            <li
              key={a.assigneeId}
              className="flex items-center justify-between gap-3 rounded-xl border border-border/60 p-3 text-sm"
            >
              <div className="min-w-0">
                <div className="truncate text-fg">{a.assigneeUsername}</div>
                <div className="text-xs text-muted">
                  {t(`tasks:analytics.statuses.${a.status.toLowerCase()}`)}
                </div>
              </div>
              <div className="shrink-0 text-right text-xs text-muted">
                {a.turnaroundSeconds != null ? (
                  <span>
                    {t("tasks:analytics.task.turnaround", {
                      time: formatMs(a.turnaroundSeconds * 1000),
                    })}
                  </span>
                ) : (
                  <span>{t("tasks:analytics.task.notCompleted")}</span>
                )}
                {a.assignedAt && (
                  <div>
                    {new Date(a.assignedAt).toLocaleDateString(i18n.language, {
                      dateStyle: "medium",
                    })}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
