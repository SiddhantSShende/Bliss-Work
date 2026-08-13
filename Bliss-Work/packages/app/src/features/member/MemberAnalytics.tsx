import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import {
  BarChart,
  EmptyState,
  Heatmap,
  RankedBars,
  Spinner,
  StatTile,
  formatMs,
} from "@taskboard/ui";
import { useRuntime } from "../../lib/runtime";
import { qk } from "../../lib/queryBridge";
import { Tabs, type TabSpec } from "../Tabs";
import { computeRange, type RangeKey } from "../../lib/dateRange";
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

  if (isLoading) return <div className="flex justify-center p-8"><Spinner /></div>;
  if (!data || data.days.length === 0)
    return (
      <div className="space-y-4">
        <Tabs tabs={RANGES} active={range} onChange={setRange} />
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
    label: new Date(d.day).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
    title: new Date(d.day).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }),
    value: d.activeMs,
    context: d.idleMs,
  }));

  return (
    <div className="space-y-6">
      <Tabs tabs={RANGES} active={range} onChange={setRange} />

      {/* A KPI row, not a chart: four current values are numbers, and drawing
          them as bars would add axes around four facts. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Active time"
          value={formatMs(data.totalActiveMs)}
          hint={`across ${activeDays} day${activeDays === 1 ? "" : "s"}`}
          trend={days.map((d) => d.activeMs)}
        />
        <StatTile
          label="Typical day"
          value={formatMs(activeDays ? data.totalActiveMs / activeDays : 0)}
          hint="on days they worked"
        />
        {/* The headline for "what were they doing off-task": time spent outside
            BlissWork entirely. Only populated once the browser extension and/or
            desktop agent are reporting — otherwise there is no off-app signal to
            show, and it reads 0 rather than implying they never left. */}
        <StatTile
          label="Outside BlissWork"
          value={formatMs(outsideMs)}
          hint={siteMs || otherAppMs ? "browsing + other apps" : "no agent data yet"}
        />
        <StatTile label="Actions" value={String(data.events)} hint="recorded events" />
      </div>

      <Section title="Active time per day" hint="Purple is time at the keyboard; grey is time signed in but idle.">
        <BarChart data={bars} valueLabel="Active" contextLabel="Idle" />
      </Section>

      <Section title="When they work" hint="Darker means more active time in that hour.">
        <Heatmap grid={data.hourly} />
      </Section>

      <div className="grid gap-6 md:grid-cols-2">
        <Section title="Where they spend time" hint="Sections of BlissWork, by time.">
          <RankedBars
            data={data.bySurface.map((s) => ({
              key: s.key, label: surfaceLabel(s.key) ?? s.key, value: s.valueMs,
            }))}
          />
        </Section>
        <Section title="What they do" hint="Recorded actions, by count.">
          <RankedBars
            data={data.byAction.map((a) => ({ key: a.key, label: a.label, value: a.count }))}
            format={(v) => String(v)}
          />
        </Section>
      </div>

      {(data.topApps.length > 0 || data.topSites.length > 0) && (
        <div className="grid gap-6 md:grid-cols-2">
          <Section title="Apps used" hint="From the desktop app, when enabled.">
            <RankedBars
              data={data.topApps.map((a) => ({ key: a.key, label: a.label, value: a.valueMs }))}
              emptyHint="No desktop app activity recorded."
            />
          </Section>
          <Section title="Sites visited" hint="From the browser extension, when installed.">
            <RankedBars
              data={data.topSites.map((s) => ({ key: s.key, label: s.label, value: s.valueMs }))}
              emptyHint="No browsing activity recorded."
            />
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-fg">{title}</h4>
        <p className="text-xs text-muted">{hint}</p>
      </div>
      {children}
    </section>
  );
}
