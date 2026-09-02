import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  CalendarClock,
  Clock,
  ExternalLink,
  Globe,
  Layers,
  LogIn,
  Monitor,
  Sparkles,
  Timer,
  TrendingUp,
  Zap,
} from "lucide-react";
import {
  Badge,
  BarChart,
  Card,
  EmptyState,
  Heatmap,
  RankedBars,
  Sparkline,
  Spinner,
  formatMs,
} from "@taskboard/ui";
import { useRuntime } from "../../lib/runtime";
import { qk } from "../../lib/queryBridge";
import { Tabs, type TabSpec } from "../Tabs";
import { computeRange, parseLocalDay, type RangeKey } from "../../lib/dateRange";
import { surfaceLabel } from "./activityLabels";

const RANGES: TabSpec<RangeKey>[] = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
];

/** Charts for one member. `userId` may be "me" — the server resolves it. */
export function MemberAnalytics({ userId }: { userId: string }) {
  const { api } = useRuntime();
  const [range, setRange] = useState<RangeKey>("30d");
  const { from, to } = computeRange(range);

  const { data, isLoading } = useQuery({
    queryKey: qk.activitySummary(userId, from, to),
    queryFn: () => api.activitySummary(userId, { from, to }),
  });

  if (isLoading)
    return (
      <div className="space-y-6">
        <AnalyticsHeader range={range} onRangeChange={setRange} />
        <div className="flex justify-center p-8"><Spinner /></div>
      </div>
    );
  if (!data || data.days.length === 0)
    return (
      <div className="space-y-6">
        <AnalyticsHeader range={range} onRangeChange={setRange} />
        <EmptyState
          icon={<BarChart3 size={22} />}
          title="No activity in this period"
          hint="Charts appear once there is a day of activity to plot."
        />
      </div>
    );

  const days = data.days;
  const activeDays = days.filter((d) => d.activeMs > 0).length;
  // Time OUTSIDE BlissWork for the period: browsing (all sites) + foreground
  // time in non-BlissWork desktop apps. The desktop agent reports the app it
  // runs under as "BlissWork Desktop", so that one is excluded — everything else
  // a person had in front of them counts as "not in BlissWork".
  const siteMs = data.topSites.reduce((n, s) => n + s.valueMs, 0);
  const otherAppMs = data.topApps
    .filter((a) => !/blisswork/i.test(a.key) && !/blisswork/i.test(a.label))
    .reduce((n, a) => n + a.valueMs, 0);
  const outsideMs = siteMs + otherAppMs;
  const bars = days.map((d) => ({
    label: parseLocalDay(d.day).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
    title: parseLocalDay(d.day).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }),
    value: d.activeMs,
    context: d.idleMs,
  }));

  const avgSessionMs = data.sessions > 0 ? data.totalActiveMs / data.sessions : 0;

  // The single busiest calendar day in the range — a highlight, not a new
  // metric: it is the same `days` series the bar chart already draws.
  const peakDay = days.reduce(
    (best, d) => (d.activeMs > (best?.activeMs ?? -1) ? d : best),
    undefined as (typeof days)[number] | undefined,
  );
  const peakDayLabel = peakDay
    ? parseLocalDay(peakDay.day).toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : null;

  // The busiest hour-of-day, summed across every day in the range — the same
  // `hourly` grid the heatmap below renders, collapsed to its one loudest column.
  const hourTotals = Array.from({ length: 24 }, (_, h) =>
    data.hourly.reduce((sum, row) => sum + (row[h] ?? 0), 0),
  );
  let peakHour = 0;
  let peakHourMs = 0;
  hourTotals.forEach((ms, h) => {
    if (ms > peakHourMs) {
      peakHourMs = ms;
      peakHour = h;
    }
  });
  const hourLabel = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

  return (
    <div className="space-y-6">
      <AnalyticsHeader range={range} onRangeChange={setRange} />

      {/* A KPI row, not a chart: current totals are numbers, and drawing them
          as bars would add axes around a handful of facts. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          featured
          icon={<Clock size={15} />}
          label="Active time"
          value={formatMs(data.totalActiveMs)}
          hint={`across ${activeDays} day${activeDays === 1 ? "" : "s"}`}
          trend={days.map((d) => d.activeMs)}
        />
        <KpiCard
          icon={<LogIn size={15} />}
          label="Sessions"
          value={String(data.sessions)}
          hint="recorded sign-ins"
        />
        <KpiCard
          icon={<Timer size={15} />}
          label="Avg. session"
          value={formatMs(avgSessionMs)}
          hint="active time per session"
        />
        {/* The headline for "what were they doing off-task": time spent outside
            BlissWork entirely. Only populated once the browser extension and/or
            desktop agent are reporting — otherwise there is no off-app signal to
            show, and it reads 0 rather than implying they never left. */}
        <KpiCard
          icon={<ExternalLink size={15} />}
          label="Outside BlissWork"
          value={formatMs(outsideMs)}
          hint={siteMs || otherAppMs ? "browsing + other apps" : "no agent data yet"}
        />
        <KpiCard icon={<Zap size={15} />} label="Actions" value={String(data.events)} hint="recorded events" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          icon={<TrendingUp size={16} />}
          title="Active time per day"
          hint="Purple is time at the keyboard; grey is time signed in but idle."
        >
          <BarChart data={bars} valueLabel="Active" contextLabel="Idle" />
        </SectionCard>

        <SectionCard icon={<Sparkles size={16} />} title="Highlights" hint="Standout moments from this period.">
          <ul className="space-y-3 text-sm">
            <HighlightRow
              label="Best day"
              value={peakDay && peakDay.activeMs > 0 ? `${peakDayLabel} · ${formatMs(peakDay.activeMs)}` : "—"}
            />
            <HighlightRow
              label="Peak hours"
              value={peakHourMs > 0 ? `${hourLabel(peakHour)}–${hourLabel(peakHour + 1)}` : "No hourly data yet"}
            />
            <HighlightRow label="Idle, signed in" value={formatMs(data.totalIdleMs)} />
          </ul>
        </SectionCard>
      </div>

      <SectionCard icon={<CalendarClock size={16} />} title="When they work" hint="Darker means more active time in that hour.">
        <Heatmap grid={data.hourly} />
      </SectionCard>

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard icon={<Layers size={16} />} title="Where they spend time" hint="Sections of BlissWork, by time.">
          <RankedBars
            data={data.bySurface.map((s) => ({
              key: s.key, label: surfaceLabel(s.key) ?? s.key, value: s.valueMs,
            }))}
          />
        </SectionCard>
        <SectionCard icon={<Activity size={16} />} title="What they do" hint="Recorded actions, by count.">
          <RankedBars
            data={data.byAction.map((a) => ({ key: a.key, label: a.label, value: a.count }))}
            format={(v) => String(v)}
          />
        </SectionCard>
      </div>

      {(data.topApps.length > 0 || data.topSites.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          <SectionCard
            icon={<Monitor size={16} />}
            title="Apps used"
            hint="From the desktop app, when enabled."
            meta={data.topApps.length > 0 && <Badge>{data.topApps.length}</Badge>}
          >
            <RankedBars
              data={data.topApps.map((a) => ({ key: a.key, label: a.label, value: a.valueMs }))}
              emptyHint="No desktop app activity recorded."
            />
          </SectionCard>
          <SectionCard
            icon={<Globe size={16} />}
            title="Sites visited"
            hint="From the browser extension, when installed."
            meta={data.topSites.length > 0 && <Badge>{data.topSites.length}</Badge>}
          >
            <RankedBars
              data={data.topSites.map((s) => ({ key: s.key, label: s.label, value: s.valueMs }))}
              emptyHint="No browsing activity recorded."
            />
          </SectionCard>
        </div>
      )}
    </div>
  );
}

/** Section intro + the range switch — shared across the loading, empty and
 *  loaded states so the controls don't pop in only once data resolves. */
function AnalyticsHeader({
  range,
  onRangeChange,
}: {
  range: RangeKey;
  onRangeChange: (range: RangeKey) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="text-base font-semibold text-fg">Activity overview</h3>
        <p className="text-sm text-muted">Time, sessions, and focus across apps and sites.</p>
      </div>
      <Tabs tabs={RANGES} active={range} onChange={onRangeChange} />
    </div>
  );
}

/** One headline number in its own card — an icon for scanability, and an
 *  accent ring on the `featured` tile so the primary metric of the row (active
 *  time) reads first without giving it a different card shape or color. */
function KpiCard({
  icon,
  label,
  value,
  hint,
  trend,
  featured,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  trend?: number[];
  featured?: boolean;
}) {
  return (
    <Card className={`flex flex-col gap-2 p-4 ${featured ? "ring-1 ring-accent/30" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          {icon}
        </span>
      </div>
      <div className={`font-semibold tabular-nums text-fg ${featured ? "text-2xl" : "text-xl"}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
      {trend && trend.length > 1 && <Sparkline values={trend} />}
    </Card>
  );
}

/** A titled card for one analytical section — the card is what gives every
 *  section below the KPI row its rounded-border, soft-shadow structure. */
function SectionCard({
  icon,
  title,
  hint,
  meta,
  children,
  className = "",
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={`p-5 ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          {icon && (
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
              {icon}
            </span>
          )}
          <div>
            <h4 className="text-sm font-semibold text-fg">{title}</h4>
            {hint && <p className="text-xs text-muted">{hint}</p>}
          </div>
        </div>
        {meta}
      </div>
      {children}
    </Card>
  );
}

function HighlightRow({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border/50 pb-3 last:border-0 last:pb-0">
      <span className="text-muted">{label}</span>
      <span className="font-medium tabular-nums text-fg">{value}</span>
    </li>
  );
}
