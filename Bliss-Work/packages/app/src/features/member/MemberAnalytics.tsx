import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Activity,
  BarChart3,
  CalendarClock,
  Clock,
  History,
  Layers,
  LayoutGrid,
  LogIn,
  TrendingUp,
  Zap,
} from "lucide-react";
import { EmptyState, Spinner } from "@taskboard/ui";
import { formatMs } from "../../i18n/format";
import { useRuntime } from "../../lib/runtime";
import { qk } from "../../lib/queryBridge";
import { relativeTime } from "../../lib/relativeTime";
import { Tabs } from "../Tabs";
import { activityRanges, computeRange, type RangeKey } from "../../lib/dateRange";
import { ActivityTrendChart, MiniSparkline, WorkHeatmap } from "./MemberAnalyticsCharts";
import {
  ActivityOverviewBody,
  RecentActivityBody,
  SectionCard,
  SummaryCard,
  TopAppsBody,
} from "./MemberAnalyticsParts";
import { percentChange, previousRange, weekdayAverages } from "./memberAnalyticsData";

/** Analytics for one member. `userId` may be "me" — the server resolves it.
 *  `onViewAllActivity` lets the host switch to its Activity tab. */
export function MemberAnalytics({
  userId,
  onViewAllActivity,
}: {
  userId: string;
  onViewAllActivity?: () => void;
}) {
  const { t } = useTranslation("members");
  const { api } = useRuntime();
  const [range, setRange] = useState<RangeKey>("30d");
  const { from, to } = computeRange(range);
  const prev = previousRange(from, to);

  const { data, isLoading } = useQuery({
    queryKey: qk.activitySummary(userId, from, to),
    queryFn: () => api.activitySummary(userId, { from, to }),
  });
  // The same window one period earlier, only to put a real "vs previous period"
  // figure under the totals. Absent or empty → no comparison is drawn.
  const { data: previous } = useQuery({
    queryKey: qk.activitySummary(userId, prev.from, prev.to),
    queryFn: () => api.activitySummary(userId, prev),
  });
  // Newest rows of the Activity tab's own timeline: they feed both the Recent
  // Activity list and the Last Active card.
  const { data: recent } = useQuery({
    queryKey: [...qk.activityTimeline(userId), "analytics-recent"],
    queryFn: () => api.activityTimeline(userId, { limit: 5 }),
  });

  const rangePicker = (
    <div className="flex justify-end">
      <Tabs tabs={activityRanges()} active={range} onChange={setRange} />
    </div>
  );

  if (isLoading)
    return (
      <div className="space-y-6">
        {rangePicker}
        <div className="flex justify-center p-8"><Spinner /></div>
      </div>
    );
  if (!data || data.days.length === 0)
    return (
      <div className="space-y-6">
        {rangePicker}
        <EmptyState
          icon={<BarChart3 size={22} />}
          title={t("members:analytics.empty.title")}
          hint={t("members:analytics.empty.hint")}
        />
      </div>
    );

  const activeDays = data.days.filter((d) => d.activeMs > 0).length;
  const entries = recent?.entries ?? [];
  const lastActiveAt = entries[0]?.occurredAt;
  const change = (cur: number, before: number | undefined) =>
    previous ? percentChange(cur, before ?? 0) : null;
  // Chronological per-day series for the KPI cards' sparklines — real rollup
  // data for the selected member and range, never fabricated. Days without a
  // rollup row are 0, not skipped, so the bars still read left-to-right as time.
  const sortedDays = [...data.days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const activeMsSeries = sortedDays.map((d) => d.activeMs);
  const sessionsSeries = sortedDays.map((d) => d.sessions);
  const eventsSeries = sortedDays.map((d) => d.events);
  // "Last Active" has no magnitude of its own to chart — only recency — so its
  // sparkline instead shows which of those same days had any activity at all,
  // the frequency pattern behind the "N minutes ago" headline.
  const activeDaySeries = sortedDays.map((d) => (d.activeMs > 0 ? 1 : 0));

  return (
    <div className="space-y-5">
      {rangePicker}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryCard
          icon={<Clock size={16} />}
          label={t("members:analytics.summary.activeTime")}
          value={formatMs(data.totalActiveMs)}
          hint={t("members:analytics.summary.acrossDays", { count: activeDays })}
          change={change(data.totalActiveMs, previous?.totalActiveMs)}
          sparkline={<MiniSparkline values={activeMsSeries} color="var(--color-chart-ink)" title={t("members:analytics.summary.activeTime")} />}
        />
        <SummaryCard
          icon={<LogIn size={16} />}
          label={t("members:analytics.summary.sessions")}
          value={String(data.sessions)}
          hint={t("members:analytics.summary.sessionsHint")}
          change={change(data.sessions, previous?.sessions)}
          sparkline={<MiniSparkline values={sessionsSeries} color="var(--color-chart-ink)" title={t("members:analytics.summary.sessions")} />}
        />
        <SummaryCard
          icon={<Zap size={16} />}
          label={t("members:analytics.summary.events")}
          value={String(data.events)}
          hint={t("members:analytics.summary.eventsHint")}
          change={change(data.events, previous?.events)}
          sparkline={<MiniSparkline values={eventsSeries} color="var(--color-chart-ink)" title={t("members:analytics.summary.events")} />}
        />
        <SummaryCard
          icon={<History size={16} />}
          label={t("members:analytics.summary.lastActive")}
          value={lastActiveAt ? relativeTime(lastActiveAt) : "—"}
          hint={
            lastActiveAt
              ? new Date(lastActiveAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
              : t("members:analytics.summary.lastActiveNone")
          }
          sparkline={<MiniSparkline values={activeDaySeries} color="var(--color-chart-context)" title={t("members:analytics.summary.lastActive")} />}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <SectionCard
          className="lg:col-span-2 xl:col-span-1"
          icon={<Activity size={17} />}
          title={t("members:analytics.overview.title")}
          hint={t("members:analytics.overview.hint")}
        >
          <ActivityOverviewBody data={data} from={from} to={to} />
        </SectionCard>
        <SectionCard
          icon={<LayoutGrid size={17} />}
          title={t("members:analytics.topApps.title")}
          hint={t("members:analytics.topApps.hint")}
        >
          <TopAppsBody apps={data.topApps} />
        </SectionCard>
        <SectionCard
          icon={<Layers size={17} />}
          title={t("members:analytics.recent.title")}
          hint={t("members:analytics.recent.hint")}
        >
          <RecentActivityBody entries={entries} onViewAll={onViewAllActivity} />
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <SectionCard
          icon={<CalendarClock size={17} />}
          title={t("members:analytics.work.title")}
          hint={t("members:analytics.work.hint")}
        >
          <WorkHeatmap grid={data.hourly} />
        </SectionCard>
        <SectionCard
          icon={<TrendingUp size={17} />}
          title={t("members:analytics.trend.title")}
          hint={t("members:analytics.trend.hint")}
        >
          <ActivityTrendChart points={weekdayAverages(data.days, from, to)} />
        </SectionCard>
      </div>
    </div>
  );
}
