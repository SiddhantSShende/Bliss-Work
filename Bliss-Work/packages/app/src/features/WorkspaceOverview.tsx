import { useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, EmptyState, Spinner } from "@taskboard/ui";
import {
  ActivityPulseChart,
  OverviewKpiGrid,
  ProjectPerformanceList,
  StatusDonut,
  StatusFlowChart,
  WorkloadMatrixTable,
  WorkloadScatterChart,
} from "./WorkspaceOverviewParts";
import { Tabs } from "./Tabs";
import { useProjects } from "./useProjects";
import { activityRanges, computeRange, type RangeKey } from "../lib/dateRange";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useUserLabels } from "../lib/userLabel";

/** Workspace analytics: KPI totals (with trend + sparkline), project/person
 *  rankings, and distribution/activity charts. Open to every authenticated
 *  member — the server (tasks_analytics.workspace_overview) scopes a
 *  non-admin's results to tasks they're already a party to (sender or
 *  assignee); org_admin sees the unrestricted, org-wide rollup. This is the
 *  Analytics page's Overview entry, selected whenever no channel/project is
 *  picked. This dashboard is project-wise — see ProjectPerformanceList;
 *  channel-wise analytics still live at their own per-channel route. */
export function WorkspaceOverview() {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const [range, setRange] = useState<RangeKey>("30d");
  const [projectId, setProjectId] = useState<string>("");
  const { from, to } = computeRange(range);

  // Same qk.projects query the Analytics sidebar already fires — TanStack
  // dedupes it, so this adds no extra request.
  const { data: projects = [] } = useProjects();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.workspaceAnalyticsOverview(from, to, projectId || undefined),
    queryFn: () => api.workspaceAnalyticsOverview({ from, to, projectId: projectId || undefined }),
  });

  // `assigneeUsername` is an auth-svc-derived handle (the email local-part),
  // not a display name — see userLabel.ts's module docstring. The directory
  // already carries the real displayName for every id this table will ever
  // show (the ids are already in hand from `data.workload`), so resolve
  // through it instead of rendering the raw DTO field.
  const workloadIds = useMemo(() => data?.workload.map((w) => w.assigneeId), [data?.workload]);
  const { nameOf } = useUserLabels(workloadIds);
  const nameOfPerson = (id: string) =>
    nameOf(id, data?.workload.find((w) => w.assigneeId === id)?.assigneeUsername);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs tabs={activityRanges()} active={range} onChange={setRange} />
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label={t("tasks:analyticsHub.overview.projectFilterLabel")}
          className="h-9 max-w-[12rem] rounded-xl border border-border bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25"
        >
          <option value="">{t("tasks:analyticsHub.overview.allProjects")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
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
            totalTasks={data.kpis.totalTasks}
            completed={data.kpis.completed}
            inProgress={data.kpis.inProgress}
            overdue={data.kpis.overdue}
          />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="flex min-w-0 flex-col gap-3 p-4">
              <h3 className="text-sm font-semibold text-fg">
                {t("tasks:analyticsHub.overview.sections.projectPerformance")}
              </h3>
              <ProjectPerformanceList
                projects={data.projectPerformance}
                emptyHint={t("tasks:analyticsHub.overview.empty.hint")}
              />
            </Card>

            <Card className="flex min-w-0 flex-col gap-3 p-4">
              <h3 className="text-sm font-semibold text-fg">
                {t("tasks:analyticsHub.overview.sections.personWorkload")}
              </h3>
              <WorkloadMatrixTable
                workload={data.workload}
                nameOf={nameOfPerson}
                emptyHint={t("tasks:analyticsHub.overview.empty.hint")}
              />
            </Card>

            <Card className="flex min-w-0 flex-col gap-3 p-4">
              <h3 className="text-sm font-semibold text-fg">
                {t("tasks:analyticsHub.overview.sections.workloadVsCompletion")}
              </h3>
              <WorkloadScatterChart
                workload={data.workload}
                nameOf={nameOfPerson}
                emptyHint={t("tasks:analyticsHub.overview.empty.hint")}
              />
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="flex min-w-0 flex-col gap-3 p-4">
              <h3 className="text-sm font-semibold text-fg">
                {t("tasks:analyticsHub.overview.sections.statusDistribution")}
              </h3>
              <StatusDonut breakdown={data.statusBreakdown} />
            </Card>

            <Card className="flex min-w-0 flex-col gap-2 p-4">
              <h3 className="text-sm font-semibold text-fg">
                {t("tasks:analyticsHub.overview.sections.statusFlow")}
              </h3>
              <p className="text-xs text-muted">{t("tasks:analyticsHub.overview.statusFlowHint")}</p>
              <StatusFlowChart points={data.statusFlow} />
            </Card>

            <Card className="flex min-w-0 flex-col gap-3 p-4">
              <h3 className="text-sm font-semibold text-fg">
                {t("tasks:analyticsHub.overview.sections.activityPulse")}
              </h3>
              <ActivityPulseChart points={data.dailyActivity} />
            </Card>
          </div>
        </div>
      )}
    </section>
  );
}
