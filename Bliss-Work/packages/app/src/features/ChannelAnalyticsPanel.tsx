import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { EmptyState, Spinner } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryKeys";
import { useUserLabels } from "../lib/userLabel";
import {
  CompletionRing,
  KpiTile,
  StatusBreakdownBar,
  WorkloadBars,
} from "./TaskAnalyticsParts";

/**
 * Snapshot analytics across every task attached to a channel: unique-task
 * counts, status breakdown, the two completion metrics, and per-assignee
 * workload. See TaskAnalyticsParts.tsx and the completion-scope rule in
 * domain.ts — assignmentCompletionRate and uniqueTaskCompletionRate are always
 * shown as separate tiles, each with a tooltip naming exactly what it is.
 */
export function ChannelAnalyticsPanel({ channelId }: { channelId: string }) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const { data, isLoading, isError } = useQuery({
    queryKey: qk.channelAnalytics(channelId),
    queryFn: () => api.channelAnalytics(channelId),
  });
  const workloadIds = useMemo(() => data?.workload.map((w) => w.assigneeId), [data?.workload]);
  const { nameOf } = useUserLabels(workloadIds);

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
  // N = 0: no tasks attached to this channel yet. Every rate the server sends
  // is already 0 in this case (task-svc never divides by zero), but a 0%
  // ring/bar for a channel with no tasks at all reads as "everything failed"
  // rather than "nothing exists yet" — so this renders a clean empty state
  // instead of the charts.
  if (data.completion.totalUniqueTasks === 0) {
    return (
      <EmptyState
        icon={<BarChart3 size={22} />}
        title={t("tasks:analytics.channel.emptyTitle")}
        hint={t("tasks:analytics.channel.emptyHint")}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile
          label={t("tasks:analytics.channel.totalTasks")}
          value={String(data.completion.totalUniqueTasks)}
        />
        <KpiTile
          label={t("tasks:analytics.channel.completedTasks")}
          value={String(data.completion.completedUniqueTasks)}
        />
        <KpiTile
          label={t("tasks:analytics.channel.abandonedTasks")}
          value={String(data.completion.abandonedUniqueTasks)}
        />
        <KpiTile
          label={t("tasks:analytics.channel.remainingTasks")}
          value={String(data.completion.remainingUniqueTasks)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <KpiTile
          label={t("tasks:analytics.completion.assignmentRate")}
          value={`${Math.round(data.completion.assignmentCompletionRate)}%`}
          hint={`${data.completion.completedAssignments}/${data.completion.totalAssignments}`}
          tooltip={t("tasks:analytics.completion.assignmentRateTooltip")}
        />
        <div title={t("tasks:analytics.completion.uniqueRateTooltip")}>
          <CompletionRing
            percent={data.completion.uniqueTaskCompletionRate}
            label={t("tasks:analytics.completion.uniqueRate")}
          />
        </div>
      </div>

      <StatusBreakdownBar breakdown={data.statusBreakdown} />

      <div>
        <h4 className="mb-2 text-sm font-semibold text-fg">
          {t("tasks:analytics.channel.workloadHeading")}
        </h4>
        <WorkloadBars workload={data.workload} nameOf={nameOf} />
      </div>
    </div>
  );
}
