import { useState } from "react";
import { BarChart3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Button, EmptyState, Spinner } from "@taskboard/ui";
import type { ChannelDTO } from "@taskboard/shared";
import { StatusBreakdownBar } from "./TaskAnalyticsParts";
import {
  ActivityPulseChart,
  ChannelPerformanceList,
  OverviewKpiGrid,
  StatusDonut,
  WorkloadMatrixTable,
  WorkloadScatterChart,
} from "./WorkspaceOverviewParts";
import { Tabs } from "./Tabs";
import { activityRanges, computeRange, type RangeKey } from "../lib/dateRange";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

/** Workspace analytics: KPI totals, channel/person rankings, and
 *  distribution/activity charts. Open to every authenticated member — the
 *  server (tasks_analytics.workspace_overview) scopes a non-admin's results
 *  to tasks they're already a party to (sender or assignee); org_admin sees
 *  the unrestricted, org-wide rollup. This is the Analytics page's Overview
 *  entry, selected whenever no channel/project is picked. */
export function WorkspaceOverview() {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const [range, setRange] = useState<RangeKey>("30d");
  const [channelId, setChannelId] = useState<string>("");
  const { from, to } = computeRange(range);

  // Same qk.channels query the Projects sidebar already fires — TanStack
  // dedupes it, so this adds no extra request.
  const { data: channels = [] } = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.channels(),
  });
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.workspaceAnalyticsOverview(from, to, channelId || undefined),
    queryFn: () => api.workspaceAnalyticsOverview({ from, to, channelId: channelId || undefined }),
  });

  // Channel ids the overview references but the caller isn't personally a
  // member of (e.g. a locked channel) fall back to a generic label rather
  // than fetching org-wide channel data — keeps the membership-based
  // name-privacy model intact even for admins.
  const nameOf = (id: string) =>
    channels.find((c: ChannelDTO) => c.id === id)?.name ?? t("tasks:analyticsHub.overview.privateChannel");
  const nameOfPerson = (id: string) => data?.workload.find((w) => w.assigneeId === id)?.assigneeUsername || id;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs tabs={activityRanges()} active={range} onChange={setRange} />
        <select
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          aria-label={t("tasks:analyticsHub.overview.channelFilterLabel")}
          className="h-9 rounded-xl border border-border bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
        >
          <option value="">{t("tasks:analyticsHub.overview.allChannels")}</option>
          {channels.map((c: ChannelDTO) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-8">
          <Spinner />
        </div>
      ) : isError ? (
        <div className="space-y-2">
          <EmptyState
            icon={<BarChart3 size={22} />}
            title={t("tasks:analyticsHub.overview.loadError.title")}
            hint={t("tasks:analyticsHub.overview.loadError.hint")}
          />
          <div className="flex justify-center">
            <Button variant="subtle" size="sm" onClick={() => void refetch()}>
              {t("tasks:analyticsHub.overview.loadError.retry")}
            </Button>
          </div>
        </div>
      ) : !data || data.completion.totalUniqueTasks === 0 ? (
        <EmptyState
          icon={<BarChart3 size={22} />}
          title={t("tasks:analyticsHub.overview.empty.title")}
          hint={t("tasks:analyticsHub.overview.empty.hint")}
        />
      ) : (
        <div className="space-y-6">
          <OverviewKpiGrid
            total={data.completion.totalUniqueTasks}
            completed={data.completion.completedUniqueTasks}
            inProgress={data.inProgressUniqueTasks}
            overdue={data.overdueUniqueTasks}
          />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-fg">
                {t("tasks:analyticsHub.overview.sections.channelPerformance")}
              </h3>
              <ChannelPerformanceList
                channels={data.channels}
                nameOf={nameOf}
                emptyHint={t("tasks:analyticsHub.overview.empty.hint")}
              />
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-fg">
                {t("tasks:analyticsHub.overview.sections.personWorkload")}
              </h3>
              <WorkloadMatrixTable
                workload={data.workload}
                nameOf={nameOfPerson}
                emptyHint={t("tasks:analyticsHub.overview.empty.hint")}
              />
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-fg">
                {t("tasks:analyticsHub.overview.sections.workloadVsCompletion")}
              </h3>
              <WorkloadScatterChart
                workload={data.workload}
                nameOf={nameOfPerson}
                emptyHint={t("tasks:analyticsHub.overview.empty.hint")}
              />
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-fg">
                {t("tasks:analyticsHub.overview.sections.statusDistribution")}
              </h3>
              <StatusDonut breakdown={data.statusBreakdown} />
            </section>

            <section className="space-y-2 lg:col-span-2">
              <h3 className="text-sm font-semibold text-fg">{t("tasks:analyticsHub.overview.sections.statusFlow")}</h3>
              <p className="text-xs text-muted">{t("tasks:analyticsHub.overview.statusFlowHint")}</p>
              <StatusBreakdownBar breakdown={data.statusBreakdown} />
            </section>

            <section className="space-y-3 lg:col-span-2">
              <h3 className="text-sm font-semibold text-fg">{t("tasks:analyticsHub.overview.sections.activityPulse")}</h3>
              <ActivityPulseChart points={data.dailyActivity} />
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
